/**
 * The tier ladder: rank one field string against a query, trying each tier in
 * order (exact → normalized-exact → prefix → boundary-exact → boundary →
 * multi-word → acronym → contains → fuzzy fallback) and returning the first match as
 * { score, tier, ranges }. Lower score = better. `acronym` enables the
 * (opt-in) word-initials tier.
 */

import { isBoundaryChar, splitWords, wordChar } from "./boundaries";
import { fuzzyChainMatch } from "./fuzzy";
import { buildFuzzyGate, buildPresenceGate, charMask, escapeRegex, maskIsExact } from "./gates";
import { SCORES, TYPO_PENALTY } from "./scores";
import type { HighlightRanges, MatchResult, Range } from "./types";

// Query-derived state, built once per query and reused across every field.
export type PreparedQuery = {
	query: string;
	normalizedQuery: string;
	queryWords: string[];
	// O(1) char-class mask pre-gate, valid for every tier (see charMask).
	queryMask: number;
	// Order-independent char-presence pre-filter, valid for every tier (see
	// buildPresenceGate). Only built for multi-word queries whose mask can't
	// already prove exact char presence (pure a–z queries: the mask IS that
	// check); null whenever it could reject nothing further.
	presenceGate: RegExp | null;
	// Subsequence gate for the fuzzy tier (see buildFuzzyGate).
	fuzzyGate: RegExp;
	// Lazily-built one-edit corrections of the query, each tagged with the tier a
	// hit should report; undefined until the first rescue attempt, null when the
	// query admits none. See typoRescue.
	rescueVariants?: RescueVariant[] | null;
	// Pre-gate for both rescue families; undefined = not built yet, null = query
	// admits no rescue. See typoRescue.
	rescueGate?: RegExp | null;
	variantGate?: RegExp | null;
	lastRescue?: PreparedQuery;
};

// One candidate correction of a mistyped query. `prepared` is filled in only if
// a field actually contains this variant — preparing all of them up front would
// pay per-variant cost on every gate-failed field.
type RescueVariant = {
	text: string;
	rawText: string;
	shortens: boolean;
	prepared: PreparedQuery | null;
};

// Build the query-derived state once, reused across every field. The raw query
// is stored trimmed so the exact-case tiers treat padding as insignificant,
// matching the normalized tiers (normalizeText trims).
export const prepareQuery = (query: string, normalizedQuery: string): PreparedQuery => {
	const queryMask = charMask(normalizedQuery);
	const queryWords = splitWords(normalizedQuery);
	// The presence gate only ever front-gates multi-word queries, and only when
	// the mask can't already prove exact char presence; everything else skips
	// its construction entirely.
	const needsPresenceGate = queryWords.length > 1 && !maskIsExact(queryMask);
	return {
		query: query.trim(),
		normalizedQuery,
		queryWords,
		queryMask,
		presenceGate: needsPresenceGate ? buildPresenceGate(normalizedQuery) : null,
		fuzzyGate: buildFuzzyGate(normalizedQuery),
	};
};

const sortByRangeStart = (a: Range, b: Range): number => a[0] - b[0];

// Runs of word characters, used to read off word-initial letters for the
// acronym tier. Word-internal apostrophes don't end a run: "people's" is one
// word with initial "p", not "people" + "s" — otherwise "Lao People's
// Democratic Republic" could never match "lpdr". Only the ASCII form appears
// here because normalizeText folds typographic apostrophes before this runs.
const wordRun = /[\p{L}\p{N}_]+(?:'[\p{L}\p{N}_]+)*/gu;

// First occurrence of `word` in `haystack` that is a whole word — bounded on
// both sides by a non-word character (or the string edge). Equivalent to
// membership in splitWords(haystack), but also yields the position, so the
// multi-word tier needs no precomputed word set.
const wholeWordOccurrence = (haystack: string, word: string): number => {
	let idx = haystack.indexOf(word);
	while (idx > -1) {
		const end = idx + word.length;
		if (
			(idx === 0 || !wordChar.test(haystack[idx - 1])) &&
			(end === haystack.length || !wordChar.test(haystack[end]))
		) {
			return idx;
		}
		idx = haystack.indexOf(word, idx + 1);
	}
	return -1;
};

// First occurrence of `needle` that starts at the beginning or after a word
// boundary. Walks past mid-word occurrences instead of stopping at the first.
const boundaryOccurrence = (haystack: string, needle: string): number => {
	let idx = haystack.indexOf(needle);
	while (idx > -1) {
		if (idx === 0 || isBoundaryChar(haystack[idx - 1])) return idx;
		idx = haystack.indexOf(needle, idx + 1);
	}
	return -1;
};

// Match the query against the field's word-initials (e.g. "us" → "United
// States"). Contiguous run of initials, match-sorter style. Highlights each
// matched initial character.
const acronymMatch = (normalizedField: string, normalizedQuery: string): MatchResult | null => {
	if (normalizedQuery.length < 2) return null;
	const offsets: number[] = [];
	let initials = "";
	for (const m of normalizedField.matchAll(wordRun)) {
		offsets.push(m.index);
		initials += m[0][0];
	}
	const hit = initials.indexOf(normalizedQuery);
	if (hit === -1) return null;
	return {
		score: SCORES.ACRONYM,
		tier: "acronym",
		ranges: offsets.slice(hit, hit + normalizedQuery.length).map((o) => [o, o] as Range),
	};
};

const swapAt = (s: string, j: number): string => s.slice(0, j) + s[j + 1] + s[j] + s.slice(j + 2);

const dropAt = (s: string, j: number): string => s.slice(0, j) + s.slice(j + 1);

// Shortest query any rescue will correct: below this the correction describes
// the field rather than the query, since almost every field offers a window one
// character away from a 3-character string.
const MIN_RESCUE_QUERY_LENGTH = 4;

// A drop variant is one character shorter than the query and a substituted
// window admits any character, so both need a higher bar than a same-length
// swap does.
const MIN_TYPO_QUERY_LENGTH = 5;

// Chance corrections are a multiple-comparisons problem, scaling with how many
// windows the field offers, while a high floor is paid by the short queries that
// dominate label search. A constant has to fail one workload or the other
// (@see docs/benchmarks.md).
const minTypoQueryLength = (fieldLength: number): number =>
	fieldLength <= 64 ? 5 : fieldLength <= 1024 ? 6 : 7;

export const isRescuableQuery = (normalizedQuery: string, queryWords: string[]): boolean =>
	queryWords.length === 1 && normalizedQuery.length >= MIN_RESCUE_QUERY_LENGTH;

// Only a substitution or a drop can explain an absent character class, and both
// are floored at MIN_TYPO_QUERY_LENGTH — so a shorter query keeps the strict
// mask gate. matchField and the searcher's survivor scan must ask this same
// question or the searcher silently drops hits the matcher would accept.
export const admitsMissingClass = (normalizedQuery: string, queryWords: string[]): boolean =>
	isRescuableQuery(normalizedQuery, queryWords) && normalizedQuery.length >= MIN_TYPO_QUERY_LENGTH;

const SCORE_EPSILON = 1e-9;

// Ties are reachable on both sides of the rescue/fuzzy split, and break toward
// the one-edit reading: it names the character the user got wrong, where a
// chain only says the letters appear in order.
function cheaper(a: MatchResult | null, b: MatchResult): MatchResult;
function cheaper(a: MatchResult, b: MatchResult | null): MatchResult;
function cheaper(a: MatchResult | null, b: MatchResult | null): MatchResult | null;
function cheaper(a: MatchResult | null, b: MatchResult | null): MatchResult | null {
	if (a === null) return b;
	if (b === null) return a;
	if (b.score < a.score - SCORE_EPSILON) return b;
	if (a.score < b.score - SCORE_EPSILON) return a;
	return a.tier === "fuzzy" ? b : a;
}

// The corrections below index the raw query by normalized offsets, which needs
// normalizeText's 1:1 code-point mapping. NFC can shorten decomposed input; when
// it has, there is no offset map and the caller falls back to the normalized
// correction — sound, just case-blind.
const offsetsAligned = (query: string, normalizedQuery: string): boolean =>
	query.length === normalizedQuery.length;

// A rescue rescores a corrected *query*, so it must be the user's own text with
// one character changed. Spelling it out of the normalized field instead makes
// the raw exact-case tiers report on the field's capitalization, crediting an
// ALL-CAPS query with an exact-case match it never made.
const rawSubstitution = (q: PreparedQuery, corrected: string): string => {
	const { query, normalizedQuery } = q;
	if (!offsetsAligned(query, normalizedQuery)) return corrected;
	for (let k = 0; k < corrected.length; k++) {
		if (corrected[k] !== normalizedQuery[k]) {
			return query.slice(0, k) + corrected[k] + query.slice(k + 1);
		}
	}
	return corrected;
};

const rawInsertion = (q: PreparedQuery, gapChar: string, insertAt: number): string | null => {
	const { query, normalizedQuery } = q;
	return offsetsAligned(query, normalizedQuery)
		? query.slice(0, insertAt) + gapChar + query.slice(insertAt)
		: null;
};

// A field-derived correction can't be memoized on the variant the way an
// enumerated one can, but near-misses of one intended word all spell the same
// correction, so a single slot catches nearly every repeat.
const prepareRescue = (
	q: PreparedQuery,
	rawCorrected: string,
	corrected: string,
): PreparedQuery => {
	const cached = q.lastRescue;
	if (
		cached !== undefined &&
		cached.query === rawCorrected &&
		cached.normalizedQuery === corrected
	) {
		return cached;
	}
	return (q.lastRescue = prepareQuery(rawCorrected, corrected));
};

// Only a real-tier hit counts: rescuing a fuzzy chain is an invented edit on top
// of a speculative assembly, and just inflates noise (@see docs/benchmarks.md).
// The `rescued` flag disables every rescue inside the recursion, so the penalty
// cannot apply twice.
const rescueWith = (
	field: string,
	normalizedField: string,
	fieldMask: number,
	prepared: PreparedQuery,
	acronym: boolean,
): MatchResult | null => {
	const result = matchField(field, normalizedField, fieldMask, prepared, acronym, true);
	return result && result.score <= SCORES.CONTAINS
		? {
				score: result.score + TYPO_PENALTY,
				tier: "corrected",
				corrected: prepared.query,
				ranges: result.ranges,
			}
		: null;
};

// Every single-character correction of a mistyped query that can be enumerated
// cheaply. Swaps and drops are both O(query length) families; the third kind — a
// query *missing* a character — is not, since it would mean trying every
// possible insertion, so it is recovered from the fuzzy chain instead (see
// missingCharRescue). A swap and a drop can never produce the same string (they
// differ in length), so the two families never collide.
const buildRescueVariants = (query: string, normalizedQuery: string): RescueVariant[] => {
	const seen = new Set<string>();
	const variants: RescueVariant[] = [];
	const aligned = offsetsAligned(query, normalizedQuery);
	const add = (j: number, edit: (s: string, j: number) => string): void => {
		const text = edit(normalizedQuery, j);
		if (seen.has(text)) return;
		seen.add(text);
		variants.push({
			text,
			rawText: aligned ? edit(query, j) : text,
			shortens: text.length < normalizedQuery.length,
			prepared: null,
		});
	};
	// Adjacent swap: "geenric" → "generic". An identity swap is not a variant.
	for (let j = 0; j < normalizedQuery.length - 1; j++) {
		if (normalizedQuery[j] !== normalizedQuery[j + 1]) add(j, swapAt);
	}
	// One character too many: "generric" → "generic". Dropping either half of a
	// repeated pair yields the same string, which the dedupe collapses.
	if (normalizedQuery.length >= MIN_TYPO_QUERY_LENGTH) {
		for (let j = 0; j < normalizedQuery.length; j++) add(j, dropAt);
	}
	return variants;
};

// A swapped or doubled keystroke leaves the field passing the mask gate while
// failing the order-sensitive tiers. Since only a real tier can be rescued, the
// corrected query must appear contiguously in the field — which is what lets one
// alternation gate reject a field outright, before any variant is prepared.
const typoRescue = (
	field: string,
	normalizedField: string,
	fieldMask: number,
	q: PreparedQuery,
	acronym: boolean,
): MatchResult | null => {
	let gate = q.rescueGate;
	if (gate === undefined) {
		const variants = buildRescueVariants(q.query, q.normalizedQuery);
		q.rescueVariants = variants.length ? variants : null;
		const literals = variants.map((v) => escapeRegex(v.text));
		q.variantGate = literals.length ? new RegExp(literals.join("|")) : null;
		// substitutedWindows only inspects positions indexOf finds for one of
		// the query's halves, so a field holding neither provably has no window:
		// adding them makes one native test rule out both families, on the path
		// nearly every field takes. The gate may only false-pass, so it uses the
		// lowest value the field-scaled floor can take and leaves that floor to
		// substitutionRescue.
		if (q.normalizedQuery.length >= MIN_TYPO_QUERY_LENGTH) {
			const splitAt = q.normalizedQuery.length >> 1;
			literals.push(
				escapeRegex(q.normalizedQuery.slice(0, splitAt)),
				escapeRegex(q.normalizedQuery.slice(splitAt)),
			);
		}
		gate = q.rescueGate = literals.length ? new RegExp(literals.join("|")) : null;
	}
	if (gate === null || !gate.test(normalizedField)) return null;

	let best: MatchResult | null = null;
	if (q.variantGate !== null && (q.variantGate as RegExp).test(normalizedField)) {
		const floor = minTypoQueryLength(normalizedField.length);
		for (const variant of q.rescueVariants as RescueVariant[]) {
			// Only a drop shortens the query, so only it answers to the
			// field-length floor; a swap stays on MIN_RESCUE_QUERY_LENGTH.
			if (variant.shortens && q.normalizedQuery.length < floor) continue;
			if (!normalizedField.includes(variant.text)) continue;
			const prepared = (variant.prepared ??= prepareQuery(variant.rawText, variant.text));
			// Enumeration order is by edit position, which says nothing about how
			// well each variant reads, so the family is priced before one is taken.
			best = cheaper(best, rescueWith(field, normalizedField, fieldMask, prepared, acronym));
			// A corrected exact hit is every rescue's floor: unbeatable.
			if (best !== null && best.score <= TYPO_PENALTY) return best;
		}
	}

	// A query mistyped at its first or last character has two valid readings —
	// "ergonomiq" is a substitution, but dropping the "q" leaves "ergonomi", a
	// prefix — and the enumerated families are tried first, so the worse one
	// would win by default.
	return cheaper(best, substitutionRescue(field, normalizedField, fieldMask, q, acronym));
};

// A substitution can't be enumerated the way a swap or a drop can, but by the
// pigeonhole principle splitting the query in two leaves at least one half
// intact, so those halves' occurrences are the only windows worth testing.
//
// Returns corrected text rather than indices, deduped: the text is the whole
// input to the rerun. Position must not rank them — the rerun rescans the field
// for the corrected string, so a window found mid-word can still score off the
// same word at a boundary elsewhere.
const substitutedWindows = (normalizedField: string, normalizedQuery: string): string[] => {
	const queryLen = normalizedQuery.length;
	const splitAt = queryLen >> 1;
	const corrections: string[] = [];
	for (let side = 0; side < 2; side++) {
		const offset = side === 0 ? 0 : splitAt;
		const half = side === 0 ? normalizedQuery.slice(0, splitAt) : normalizedQuery.slice(splitAt);
		for (
			let hit = normalizedField.indexOf(half);
			hit > -1;
			hit = normalizedField.indexOf(half, hit + 1)
		) {
			const start = hit - offset;
			if (start < 0 || start + queryLen > normalizedField.length) continue;
			let mismatches = 0;
			for (let k = 0; k < queryLen; k++) {
				if (normalizedField[start + k] !== normalizedQuery[k] && ++mismatches > 1) break;
			}
			// Exactly one: zero would mean the query is present verbatim, which
			// the contains tier already owns.
			if (mismatches !== 1) continue;
			const corrected = normalizedField.slice(start, start + queryLen);
			if (!corrections.includes(corrected)) corrections.push(corrected);
		}
	}
	return corrections;
};

// The substitution rescue: one wrong character ("genaric" for "generic"). Unlike
// the other three edits this one can change the query's character-class mask, so
// it is only reachable at all because the mask gate tolerates a single missing
// class (see matchField). The correction needs no enumeration — the field's own
// window is the corrected query.
const substitutionRescue = (
	field: string,
	normalizedField: string,
	fieldMask: number,
	q: PreparedQuery,
	acronym: boolean,
): MatchResult | null => {
	const { normalizedQuery } = q;
	if (normalizedQuery.length < minTypoQueryLength(normalizedField.length)) return null;

	let best: MatchResult | null = null;
	for (const corrected of substitutedWindows(normalizedField, normalizedQuery)) {
		const prepared = prepareRescue(q, rawSubstitution(q, corrected), corrected);
		best = cheaper(best, rescueWith(field, normalizedField, fieldMask, prepared, acronym));
		if (best !== null && best.score <= TYPO_PENALTY) break;
	}
	return best;
};

// A fuzzy assembly of exactly two chunks separated by exactly one field
// character is not a scattered chain — it is a dropped keystroke ("ergonmic"
// for "ergonomic"), and the character the query is missing is sitting in the
// gap, so the correction needs no enumeration at all: it is the field's own
// span. Rescued into a real tier so it ranks as the typo it is instead of
// sharing the fuzzy band with junk chains.
//
// The gap must be a word character. A skipped *separator* ("bigcat" for "big
// cat") is ordinary concatenated-word matching, not a typo — the chunk scorer
// already prices it as the cheapest fuzzy shape there is, and promoting it
// would rank it above genuine tier hits.
//
// Takes the flat minimum, not the field-scaled floor, and admits multi-word
// queries. Those floors guard a multiple-comparisons hazard that needs O(field
// length) candidate positions; the chain shape here pins the correction to one
// contiguous window at density >= 0.5, so the hazard never arises
// (@see bench/longtext.test.ts).
const missingCharRescue = (
	field: string,
	normalizedField: string,
	fieldMask: number,
	q: PreparedQuery,
	acronym: boolean,
	ranges: HighlightRanges,
): MatchResult | null => {
	if (q.normalizedQuery.length < MIN_RESCUE_QUERY_LENGTH) return null;
	if (ranges.length !== 2) return null;
	const [[startA, endA], [, endB]] = ranges;
	if (ranges[1][0] !== endA + 2 || !wordChar.test(normalizedField[endA + 1])) return null;

	const corrected = normalizedField.slice(startA, endB + 1);
	// The first chunk's length is where the query dropped the gap character.
	const raw = rawInsertion(q, normalizedField[endA + 1], endA - startA + 1);
	const prepared = prepareRescue(q, raw ?? corrected, corrected);
	return rescueWith(field, normalizedField, fieldMask, prepared, acronym);
};

export const matchField = (
	field: string,
	normalizedField: string,
	fieldMask: number,
	q: PreparedQuery,
	acronym: boolean,
	rescued = false,
): MatchResult | null => {
	const { query, normalizedQuery, queryWords } = q;

	// One integer AND before any regex: a field missing more than one of the
	// query's character classes can't match at any tier, nor be rescued — every
	// tier needs the query's classes present, a swap or a drop can only preserve
	// or shrink the query's mask, and a substitution can account for exactly one
	// missing class. `n & (n - 1)` clears the lowest set bit, so it is zero iff
	// at most one class is absent.
	const rescuable = !rescued && isRescuableQuery(normalizedQuery, queryWords);
	const missingClasses = q.queryMask & ~fieldMask;
	const relaxed = rescuable && admitsMissingClass(normalizedQuery, queryWords);
	if (relaxed ? missingClasses & (missingClasses - 1) : missingClasses) return null;
	// A class is genuinely absent, so no ordinary tier can fire — skip the ladder
	// and go straight to the rescue, which has exactly two ways to explain it: a
	// substitution (the wrong character was typed) or a drop (a character the
	// field never had was typed as well, "genexric"). A swap cannot, so its
	// variants simply fail the gate.
	if (missingClasses !== 0) {
		return typoRescue(field, normalizedField, fieldMask, q, acronym);
	}

	// Bulk-reject remaining non-candidates before the tier ladder. Single-word
	// queries use the stricter, single-pass subsequence gate (every tier needs
	// the query's chars in order when there's one word); multi-word queries must
	// use the order-independent presence gate, since the multi-word tier matches
	// words out of order and a subsequence gate would wrongly reject them — but
	// when the mask already proved exact char presence, the regex is skipped.
	const frontGate = queryWords.length > 1 ? q.presenceGate : q.fuzzyGate;
	if (frontGate && !frontGate.test(normalizedField)) {
		// Rescue viability was already decided above, so ineligible queries
		// (multi-word, short) pay nothing, not even a call, on this bulk-reject path.
		return rescuable ? typoRescue(field, normalizedField, fieldMask, q, acronym) : null;
	}

	if (field === query)
		return { score: SCORES.EXACT, tier: "exact", ranges: [[0, field.length - 1]] };

	const queryLen = query.length;
	const normalizedFieldLen = normalizedField.length;
	const normalizedQueryLen = normalizedQuery.length;

	if (normalizedField === normalizedQuery)
		return {
			score: SCORES.NORMALIZED_EXACT,
			tier: "normalized-exact",
			ranges: [[0, normalizedFieldLen - 1]],
		};
	if (normalizedField.startsWith(normalizedQuery))
		return { score: SCORES.PREFIX, tier: "prefix", ranges: [[0, normalizedQueryLen - 1]] };

	const exactBoundaryIdx = boundaryOccurrence(field, query);
	if (exactBoundaryIdx > -1) {
		return {
			score: SCORES.BOUNDARY_EXACT,
			tier: "boundary-exact",
			ranges: [[exactBoundaryIdx, exactBoundaryIdx + queryLen - 1]],
		};
	}

	const boundaryIdx = boundaryOccurrence(normalizedField, normalizedQuery);
	if (boundaryIdx > -1) {
		return {
			score: SCORES.BOUNDARY,
			tier: "boundary",
			ranges: [[boundaryIdx, boundaryIdx + normalizedQueryLen - 1]],
		};
	}

	if (queryWords.length > 1) {
		const ranges: Range[] = [];
		for (const w of queryWords) {
			const i = wholeWordOccurrence(normalizedField, w);
			if (i === -1) break;
			ranges.push([i, i + w.length - 1]);
		}
		if (ranges.length === queryWords.length) {
			return {
				score: SCORES.MULTI_WORD,
				tier: "multi-word",
				ranges: ranges.sort(sortByRangeStart),
			};
		}
	}

	// Acronym (1.8) outranks contains (2), so it must be tried first — a field
	// matching both ways must get the better tier, or cross-item ordering
	// inverts. Initials never contain a separator, so a multi-word query can
	// never acronym-match — skip the full-field initials scan for those.
	if (acronym && queryWords.length === 1) {
		const result = acronymMatch(normalizedField, normalizedQuery);
		if (result) return result;
	}

	const containsIdx = normalizedField.indexOf(normalizedQuery);
	if (containsIdx > -1)
		return {
			score: SCORES.CONTAINS,
			tier: "contains",
			ranges: [[containsIdx, containsIdx + normalizedQueryLen - 1]],
		};

	// Fuzzy fallback — gate on the native subsequence test before the loop.
	// Single-word queries already passed fuzzyGate as the ladder's front gate;
	// only multi-word queries (presence-gated up front) still owe this test.
	if (queryWords.length > 1 && !q.fuzzyGate.test(normalizedField)) return null;
	const fuzzy = fuzzyChainMatch(normalizedField, normalizedQuery);
	if (fuzzy) {
		const chain: MatchResult = { score: fuzzy[0], tier: "fuzzy", ranges: fuzzy[1] };
		if (rescued) return chain;
		// A chain assembling is not evidence it is the best reading: a decoy can
		// let junk assemble out of scraps while the field literally contains the
		// corrected word. Returning here would hide both rescues below.
		const dropped = missingCharRescue(field, normalizedField, fieldMask, q, acronym, fuzzy[1]);
		const corrected = rescuable ? typoRescue(field, normalizedField, fieldMask, q, acronym) : null;
		return cheaper(cheaper(dropped, corrected), chain);
	}
	// Every tier failed (the chain can refuse via the density floor even past
	// the gate) — last chance for the one-edit rescue.
	return rescuable ? typoRescue(field, normalizedField, fieldMask, q, acronym) : null;
};

import { isBoundaryChar, splitWords, wordChar } from "./boundaries";
import { fuzzyChainMatch } from "./fuzzy";
import { buildFuzzyGate, buildPresenceGate, charMask, maskIsExact } from "./gates";
import {
	admitsMissingClass,
	cheaper,
	isRescuableQuery,
	missingCharRescue,
	type RescueContext,
	rescueField,
	type RescueState,
	type RescueVariant,
} from "./rescue";
import { SCORES } from "./scores";
import type { MatchResult, Range, Tier } from "./types";

// Query-derived state, built once per query and reused across every field. The
// lazy fields share one protocol: undefined = not built yet, null = the query
// admits none.
export type PreparedQuery = {
	query: string;
	normalisedQuery: string;
	queryWords: string[];
	queryMask: number;
	presenceGate: RegExp | null;
	fuzzyGate: RegExp;
	rescue?: RescueState | null;
	lastRescue?: PreparedQuery;
	wordOffsets?: number[];
	wordVariants?: (RescueVariant[] | null)[];
};

// The raw query is stored trimmed so the exact-case tiers treat padding as
// insignificant, matching the normalised tiers (normaliseText trims). The
// presence gate is skipped whenever the mask already proves exact char
// presence — for pure a–z queries the mask IS that check.
export const prepareQuery = (query: string, normalisedQuery: string): PreparedQuery => {
	const queryMask = charMask(normalisedQuery);
	const queryWords = splitWords(normalisedQuery);
	const needsPresenceGate = queryWords.length > 1 && !maskIsExact(queryMask);
	return {
		query: query.trim(),
		normalisedQuery,
		queryWords,
		queryMask,
		presenceGate: needsPresenceGate ? buildPresenceGate(normalisedQuery) : null,
		fuzzyGate: buildFuzzyGate(normalisedQuery),
	};
};

const sortByRangeStart = (a: Range, b: Range): number => a[0] - b[0];

// Word-internal apostrophes don't end a run: "people's" is one word with
// initial "p", or "Lao People's Democratic Republic" could never match "lpdr".
const wordRun = /[\p{L}\p{N}_]+(?:'[\p{L}\p{N}_]+)*/gu;

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

const boundaryOccurrence = (haystack: string, needle: string): number => {
	let idx = haystack.indexOf(needle);
	while (idx > -1) {
		if (idx === 0 || isBoundaryChar(haystack[idx - 1])) return idx;
		idx = haystack.indexOf(needle, idx + 1);
	}
	return -1;
};

const boundaryTier = (
	haystack: string,
	needle: string,
	score: number,
	tier: Tier,
): MatchResult | null => {
	const idx = boundaryOccurrence(haystack, needle);
	return idx > -1 ? { score, tier, ranges: [[idx, idx + needle.length - 1]] } : null;
};

const multiWordTier = (normalisedField: string, queryWords: string[]): MatchResult | null => {
	const ranges: Range[] = [];
	for (const w of queryWords) {
		const i = wholeWordOccurrence(normalisedField, w);
		if (i === -1) return null;
		ranges.push([i, i + w.length - 1]);
	}
	return { score: SCORES.MULTI_WORD, tier: "multi-word", ranges: ranges.sort(sortByRangeStart) };
};

const acronymMatch = (normalisedField: string, normalisedQuery: string): MatchResult | null => {
	if (normalisedQuery.length < 2) return null;
	const offsets: number[] = [];
	let initials = "";
	for (const m of normalisedField.matchAll(wordRun)) {
		offsets.push(m.index);
		initials += m[0][0];
	}
	const hit = initials.indexOf(normalisedQuery);
	if (hit === -1) return null;
	return {
		score: SCORES.ACRONYM,
		tier: "acronym",
		ranges: offsets.slice(hit, hit + normalisedQuery.length).map((o) => [o, o] as Range),
	};
};

const containsTier = (normalisedField: string, normalisedQuery: string): MatchResult | null => {
	const idx = normalisedField.indexOf(normalisedQuery);
	return idx > -1
		? {
				score: SCORES.CONTAINS,
				tier: "contains",
				ranges: [[idx, idx + normalisedQuery.length - 1]],
			}
		: null;
};

const fuzzyOrRescue = (
	rescue: RescueContext,
	rescued: boolean,
	rescuable: boolean,
): MatchResult | null => {
	const { normalisedField, prepared } = rescue;
	// Single-word queries already passed fuzzyGate as the ladder's front gate;
	// only multi-word queries (presence-gated up front) still owe this test. A
	// phrase with a swapped keystroke fails it with every class present, so this
	// reject is a rescue site like the others.
	if (prepared.queryWords.length > 1 && !prepared.fuzzyGate.test(normalisedField)) {
		return rescuable ? rescueField(rescue) : null;
	}
	const fuzzy = fuzzyChainMatch(normalisedField, prepared.normalisedQuery);
	if (fuzzy) {
		const chain: MatchResult = { score: fuzzy[0], tier: "fuzzy", ranges: fuzzy[1] };
		if (rescued) return chain;
		// A chain assembling is not evidence it is the best reading: the field may
		// literally contain the corrected word, so both rescues are still priced.
		const dropped = missingCharRescue(rescue, fuzzy[1]);
		const corrected = rescuable ? rescueField(rescue) : null;
		return cheaper(cheaper(dropped, corrected), chain);
	}
	// The chain can refuse past the gate via its density floor.
	return rescuable ? rescueField(rescue) : null;
};

export const matchField = (
	field: string,
	normalisedField: string,
	fieldMask: number,
	q: PreparedQuery,
	acronym: boolean,
	rescued = false,
	gated = false,
): MatchResult | null => {
	const { query, normalisedQuery, queryWords } = q;

	// `n & (n - 1)` clears the lowest set bit, so it is zero iff at most one
	// class is absent — and only a substitution or a drop can account for
	// exactly one, so a genuinely missing class goes straight to the rescue.
	const rescuable = !rescued && isRescuableQuery(normalisedQuery, queryWords);
	const missingClasses = q.queryMask & ~fieldMask;
	const relaxed = rescuable && admitsMissingClass(normalisedQuery, queryWords);
	if (relaxed ? missingClasses & (missingClasses - 1) : missingClasses) return null;

	let rescue: RescueContext | null = null;
	const rescueContext = (): RescueContext =>
		(rescue ??= { field, normalisedField, fieldMask, prepared: q, acronym, missingClasses });

	if (missingClasses !== 0) return rescueField(rescueContext());

	// Multi-word queries must front-gate on the order-independent presence gate:
	// the multi-word tier matches words out of order, and the subsequence gate
	// would false-reject them. `gated` means the searcher already ran this exact
	// gate on this exact string.
	const frontGate = gated ? null : queryWords.length > 1 ? q.presenceGate : q.fuzzyGate;
	if (frontGate && !frontGate.test(normalisedField)) {
		return rescuable ? rescueField(rescueContext()) : null;
	}

	if (field === query) {
		return { score: SCORES.EXACT, tier: "exact", ranges: [[0, field.length - 1]] };
	}
	if (normalisedField === normalisedQuery) {
		return {
			score: SCORES.NORMALIZED_EXACT,
			tier: "normalised-exact",
			ranges: [[0, normalisedField.length - 1]],
		};
	}
	if (normalisedField.startsWith(normalisedQuery)) {
		return { score: SCORES.PREFIX, tier: "prefix", ranges: [[0, normalisedQuery.length - 1]] };
	}
	const boundary =
		boundaryTier(field, query, SCORES.BOUNDARY_EXACT, "boundary-exact") ??
		boundaryTier(normalisedField, normalisedQuery, SCORES.BOUNDARY, "boundary");
	if (boundary) return boundary;

	if (queryWords.length > 1) {
		const multi = multiWordTier(normalisedField, queryWords);
		if (multi) return multi;
	}

	// Acronym (1.8) outranks contains (2), so it must be tried first — a field
	// matching both ways must get the better tier, or cross-item ordering
	// inverts. Initials never contain a separator, so a multi-word query can
	// never acronym-match.
	if (acronym && queryWords.length === 1) {
		const result = acronymMatch(normalisedField, normalisedQuery);
		if (result) return result;
	}

	const contains = containsTier(normalisedField, normalisedQuery);
	if (contains) return contains;

	return fuzzyOrRescue(rescueContext(), rescued, rescuable);
};

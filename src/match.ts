import { isBoundaryChar, splitWords, wordChar } from "./boundaries";
import { fuzzyChainMatch } from "./fuzzy";
import { buildFuzzyGate, buildPresenceGate, charMask, isExactMask } from "./gates";
import {
	admitsMissingClass,
	isRescuableQuery,
	preferCheaper,
	missingCharRescue,
	type RescueContext,
	rescueField,
	type RescueState,
	type RescueVariant,
} from "./rescue";
import { SCORES } from "./scores";
import type { MatchResult, Range } from "./types";

// Query-derived state, built once per query and reused across every field. The
// lazy rescue fields share one protocol: undefined = not built yet, null = the
// query admits none. Declared required so every PreparedQuery keeps one object
// shape as rescue.ts fills them in.
export type PreparedQuery = {
	query: string;
	normalisedQuery: string;
	queryWords: string[];
	queryMask: number;
	presenceGate: RegExp | null;
	fuzzyGate: RegExp;
	rescueState: RescueState | null | undefined;
	lastCorrection: PreparedQuery | undefined;
	wordStarts: number[] | undefined;
	wordVariants: (RescueVariant[] | null)[] | undefined;
};

// The raw query is stored trimmed so the exact-case tiers treat padding as
// insignificant, matching the normalised tiers (normaliseText trims). The
// presence gate is skipped whenever the mask already proves exact char
// presence — for pure a–z queries the mask IS that check.
export const prepareQuery = (query: string, normalisedQuery: string): PreparedQuery => {
	const queryMask = charMask(normalisedQuery);
	const queryWords = splitWords(normalisedQuery);
	const needsPresenceGate = queryWords.length > 1 && !isExactMask(queryMask);
	return {
		query: query.trim(),
		normalisedQuery,
		queryWords,
		queryMask,
		presenceGate: needsPresenceGate ? buildPresenceGate(normalisedQuery) : null,
		fuzzyGate: buildFuzzyGate(normalisedQuery),
		rescueState: undefined,
		lastCorrection: undefined,
		wordStarts: undefined,
		wordVariants: undefined,
	};
};

const sortByRangeStart = (a: Range, b: Range): number => a[0] - b[0];

// Word-internal apostrophes don't end a run: "people's" is one word with
// initial "p", or "Lao People's Democratic Republic" could never match "lpdr".
const wordRun = /[\p{L}\p{N}_]+(?:'[\p{L}\p{N}_]+)*/gu;

const wholeWordOccurrence = (haystack: string, needle: string): number => {
	let at = haystack.indexOf(needle);
	while (at > -1) {
		const end = at + needle.length;
		if (
			(at === 0 || !wordChar.test(haystack[at - 1])) &&
			(end === haystack.length || !wordChar.test(haystack[end]))
		) {
			return at;
		}
		at = haystack.indexOf(needle, at + 1);
	}
	return -1;
};

const boundaryOccurrence = (haystack: string, needle: string): number => {
	let at = haystack.indexOf(needle);
	while (at > -1) {
		if (at === 0 || isBoundaryChar(haystack[at - 1])) return at;
		at = haystack.indexOf(needle, at + 1);
	}
	return -1;
};

const boundaryTier = (
	haystack: string,
	needle: string,
	tier: "boundary-exact" | "boundary",
): MatchResult | null => {
	const at = boundaryOccurrence(haystack, needle);
	if (at === -1) return null;
	const score = tier === "boundary-exact" ? SCORES.BOUNDARY_EXACT : SCORES.BOUNDARY;
	return { score, tier, ranges: [[at, at + needle.length - 1]] };
};

const multiWordTier = (normalisedField: string, queryWords: string[]): MatchResult | null => {
	const ranges: Range[] = [];
	for (const word of queryWords) {
		const at = wholeWordOccurrence(normalisedField, word);
		if (at === -1) return null;
		ranges.push([at, at + word.length - 1]);
	}
	return { score: SCORES.MULTI_WORD, tier: "multi-word", ranges: ranges.sort(sortByRangeStart) };
};

const acronymTier = (normalisedField: string, normalisedQuery: string): MatchResult | null => {
	if (normalisedQuery.length < 2) return null;
	const wordStarts: number[] = [];
	let initials = "";
	for (const match of normalisedField.matchAll(wordRun)) {
		wordStarts.push(match.index);
		initials += match[0][0];
	}
	const at = initials.indexOf(normalisedQuery);
	if (at === -1) return null;
	return {
		score: SCORES.ACRONYM,
		tier: "acronym",
		ranges: wordStarts
			.slice(at, at + normalisedQuery.length)
			.map((wordStart) => [wordStart, wordStart] as Range),
	};
};

const containsTier = (normalisedField: string, normalisedQuery: string): MatchResult | null => {
	const at = normalisedField.indexOf(normalisedQuery);
	return at > -1
		? {
				score: SCORES.CONTAINS,
				tier: "contains",
				ranges: [[at, at + normalisedQuery.length - 1]],
			}
		: null;
};

const fuzzyOrRescue = (
	rescue: RescueContext,
	mayRescue: boolean,
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
		const chain: MatchResult = { score: fuzzy.score, tier: "fuzzy", ranges: fuzzy.ranges };
		if (!mayRescue) return chain;
		// A chain assembling is not evidence it is the best reading: the field may
		// literally contain the corrected word, so both rescues are still priced.
		const dropped = missingCharRescue(rescue, fuzzy.ranges);
		const corrected = rescuable ? rescueField(rescue) : null;
		return preferCheaper(preferCheaper(dropped, corrected), chain);
	}
	// The chain can refuse past the gate via its density floor.
	return rescuable ? rescueField(rescue) : null;
};

// The literal rungs in ladder order: exact → normalised-exact → prefix →
// boundary ×2 → multi-word → acronym → contains. Acronym (1.8) outranks
// contains (2), so it must be tried first — a field matching both ways must
// get the better tier, or cross-item ordering inverts. Initials never contain
// a separator, so a multi-word query can never acronym-match.
const literalTiers = (
	field: string,
	normalisedField: string,
	prepared: PreparedQuery,
	acronym: boolean,
): MatchResult | null => {
	const { query, normalisedQuery, queryWords } = prepared;

	if (field === query) {
		return { score: SCORES.EXACT, tier: "exact", ranges: [[0, field.length - 1]] };
	}
	if (normalisedField === normalisedQuery) {
		return {
			score: SCORES.NORMALISED_EXACT,
			tier: "normalised-exact",
			ranges: [[0, normalisedField.length - 1]],
		};
	}
	if (normalisedField.startsWith(normalisedQuery)) {
		return { score: SCORES.PREFIX, tier: "prefix", ranges: [[0, normalisedQuery.length - 1]] };
	}
	const boundary =
		boundaryTier(field, query, "boundary-exact") ??
		boundaryTier(normalisedField, normalisedQuery, "boundary");
	if (boundary) return boundary;

	if (queryWords.length > 1) {
		const multi = multiWordTier(normalisedField, queryWords);
		if (multi) return multi;
	}

	if (acronym && queryWords.length === 1) {
		const result = acronymTier(normalisedField, normalisedQuery);
		if (result) return result;
	}

	return containsTier(normalisedField, normalisedQuery);
};

export const matchField = (
	field: string,
	normalisedField: string,
	fieldMask: number,
	prepared: PreparedQuery,
	acronym: boolean,
	mayRescue: boolean = true,
	preGated: boolean = false,
): MatchResult | null => {
	const { normalisedQuery, queryWords } = prepared;

	// `n & (n - 1)` clears the lowest set bit, so it is zero iff at most one
	// class is absent — and only a substitution or a drop can account for
	// exactly one, so a genuinely missing class goes straight to the rescue.
	const rescuable = mayRescue && isRescuableQuery(normalisedQuery, queryWords);
	const missingClasses = prepared.queryMask & ~fieldMask;
	const relaxed = rescuable && admitsMissingClass(normalisedQuery, queryWords);
	if (relaxed ? missingClasses & (missingClasses - 1) : missingClasses) return null;

	let rescue: RescueContext | null = null;
	const rescueContext = (): RescueContext =>
		(rescue ??= { field, normalisedField, fieldMask, prepared, acronym, missingClasses });

	if (missingClasses !== 0) return rescueField(rescueContext());

	// Multi-word queries must front-gate on the order-independent presence gate:
	// the multi-word tier matches words out of order, and the subsequence gate
	// would false-reject them. `preGated` means the searcher already ran this
	// exact gate on this exact string.
	const frontGate = preGated
		? null
		: queryWords.length > 1
			? prepared.presenceGate
			: prepared.fuzzyGate;
	if (frontGate && !frontGate.test(normalisedField)) {
		return rescuable ? rescueField(rescueContext()) : null;
	}

	return (
		literalTiers(field, normalisedField, prepared, acronym) ??
		fuzzyOrRescue(rescueContext(), mayRescue, rescuable)
	);
};

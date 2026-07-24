/**
 * The tier ladder: rank one field string against a query, trying each tier in
 * order (exact → normalized-exact → prefix → boundary-exact → boundary →
 * multi-word → acronym → contains → fuzzy fallback) and returning the first match as
 * { score, tier, ranges }. Lower score = better. `acronym` enables the
 * (opt-in) word-initials tier.
 */

import { isBoundaryChar, wordChar } from "./boundaries";
import { fuzzyChainMatch } from "./fuzzy";
import { SCORES } from "./scores";
import type { MatchResult, Range } from "./types";

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

export const matchField = (
	field: string,
	normalizedField: string,
	fieldMask: number,
	q: PreparedQuery,
	acronym: boolean,
): MatchResult | null => {
	const { query, normalizedQuery, queryWords } = q;

	// One integer AND before any regex: a field missing one of the query's
	// character classes can't match at any tier.
	if ((q.queryMask & fieldMask) !== q.queryMask) return null;

	// Bulk-reject remaining non-candidates before the tier ladder. Single-word
	// queries use the stricter, single-pass subsequence gate (every tier needs
	// the query's chars in order when there's one word); multi-word queries must
	// use the order-independent presence gate, since the multi-word tier matches
	// words out of order and a subsequence gate would wrongly reject them — but
	// when the mask already proved exact char presence, the regex is skipped.
	const frontGate = queryWords.length > 1 ? q.presenceGate : q.fuzzyGate;
	if (frontGate && !frontGate.test(normalizedField)) return null;

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
	return fuzzy && { score: fuzzy[0], tier: "fuzzy", ranges: fuzzy[1] };
};

/**
 * Front-of-ladder pre-filters: cheap bulk-reject machinery built once per
 * query and tested per field, so the tier ladder (and the hand-rolled fuzzy
 * matcher behind it) only ever runs on plausible candidates. Nothing here is
 * specific to any one tier — see matchField for which gate guards what.
 */

import { wordChar } from "./boundaries";

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mirrors WORD_CLASS in boundaries.ts. Kept as a class body rather than reusing
// `wordChar` because this one goes inside a lookbehind in a larger pattern.
const WORD_CLASS = "[\\p{L}\\p{N}_]";

/**
 * A cheap native gate for the fuzzy tier: the query's characters in order, with
 * anything between, anchored at a placement the chunk assembler would actually
 * try. A fuzzy match requires the query to be a subsequence of the field, and
 * `fuzzyChainMatch` only starts a chain where `admitsChunk` holds for the first
 * chunk — the placement either opens a word or runs the query's first three
 * characters consecutively. Every earlier tier satisfies one of those too
 * (contains/prefix/exact run the query outright, acronym lands on initials), so
 * for single-word queries this gates the whole ladder.
 *
 * Requiring the anchor cuts a third of the fields that reach the ladder and
 * cannot false-reject: a field with no admissible first placement has no chain
 * to assemble (@see docs/benchmarks.md).
 *
 * Monotone under query extension, which is what lets the survivor cache in
 * search.ts reuse the previous keystroke's survivors: extending the query
 * lengthens the subsequence and never changes the first three characters, so
 * both branches only ever admit fewer fields.
 */
export const buildFuzzyGate = (normalizedQuery: string): RegExp => {
	const chars = [...normalizedQuery].map(escapeRegex);
	const subsequenceFrom = (i: number): string => chars.slice(i).join("[^]*");
	const runLength = Math.min(3, chars.length);
	const run = chars.slice(0, runLength).join("");
	const afterRun = runLength < chars.length ? `[^]*${subsequenceFrom(runLength)}` : "";
	// Lookbehind rather than a consuming `(?:^|non-word)`: same survivors, ~11%
	// less scan time, and ES2018 sits inside the ES2022 target tsconfig pins.
	return new RegExp(`(?:(?<!${WORD_CLASS})${subsequenceFrom(0)}|${run}${afterRun})`, "u");
};

/**
 * A 32-bit character-class mask (fuzzysort-style O(1) pre-gate): bits 0–25 for
 * a–z, bits 26–29 for digits (bucketed), bits 30–31 for non-ASCII (bucketed).
 * Spaces and ASCII punctuation are skipped — separators must not be required of
 * the field. Query and field use the same function, so a bucket collision can
 * only cause a false pass (weaker filter), never a false reject. If
 * `(queryMask & fieldMask) !== queryMask`, some query character class is absent
 * from the field and no tier can match.
 */
export const charMask = (normalized: string): number => {
	let mask = 0;
	for (let i = 0; i < normalized.length; i++) {
		const c = normalized.charCodeAt(i);
		if (c >= 97 && c <= 122) mask |= 1 << (c - 97);
		else if (c >= 48 && c <= 57) mask |= 1 << (26 + (c & 3));
		else if (c > 127) mask |= 1 << (30 + (c & 1));
	}
	return mask;
};

// True when the mask is an exact distinct-char presence check: bits 0–25 map
// letters 1:1, so a mask without the lossy bucket bits (digits 26–29,
// non-ASCII 30–31) proves char presence on its own and the presence-gate
// regex could not reject anything further.
export const maskIsExact = (mask: number): boolean => (mask & ~0x3ffffff) === 0;

/**
 * An order-independent presence gate: every distinct word-character of the query
 * must appear somewhere in the field (uFuzzy-style native pre-filter). A necessary
 * condition for *every* tier — exact / prefix / boundary / multi-word / contains /
 * acronym / fuzzy all require the query's letters to be present — so a field that
 * fails it can't match at any tier and can skip the whole ladder. Unlike the
 * subsequence `fuzzyGate` it stays valid for out-of-order multi-word matches, and
 * word separators are excluded so `"foo bar"` still gates a field that separates
 * the words differently (`"bar/foo"`). Built once per query, tested per field.
 */
export const buildPresenceGate = (normalizedQuery: string): RegExp => {
	const seen = new Set<string>();
	let src = "^";
	for (const ch of normalizedQuery) {
		if (seen.has(ch) || !wordChar.test(ch)) continue;
		seen.add(ch);
		src += `(?=[^]*${escapeRegex(ch)})`;
	}
	return new RegExp(src);
};

/**
 * Front-of-ladder pre-filters: cheap bulk-reject machinery built once per
 * query and tested per field, so the tier ladder (and the hand-rolled fuzzy
 * matcher behind it) only ever runs on plausible candidates. Nothing here is
 * specific to any one tier — see matchField for which gate guards what.
 */

import { wordChar } from "./boundaries";

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A cheap native gate for the fuzzy tier: the query's characters, in order, with
 * anything between. A fuzzy match requires the query to be a subsequence of the
 * field, so a field that fails this test can never match — skip the expensive
 * hand-rolled matcher. For single-word queries every earlier tier needs the same
 * property, so it doubles as the front gate of the whole ladder.
 */
export const buildFuzzyGate = (normalizedQuery: string): RegExp =>
	new RegExp([...normalizedQuery].map(escapeRegex).join("[^]*"));

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

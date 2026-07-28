/**
 * Front-of-ladder pre-filters: cheap bulk-reject machinery built once per
 * query and tested per field, so the tier ladder (and the hand-rolled fuzzy
 * matcher behind it) only ever runs on plausible candidates. Nothing here is
 * specific to any one tier — see matchField for which gate guards what.
 */

import { wordChar } from "./boundaries";
import { bigramBit, bigramClass } from "./normalise";
import { unfoldTable } from "./unfold";

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Inside a character class only these four are special, and `-` needs escaping
// there while `escapeRegex` leaves it alone.
const classEscape = (s: string): string => s.replace(/[\^\]\\-]/g, "\\$&");

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
export const buildFuzzyGate = (normalisedQuery: string): RegExp => {
	const points = [...normalisedQuery];
	const chars = points.map(escapeRegex);
	// `[^x]*x` rather than `[^]*x`: excluding the character that ends the gap
	// leaves each step exactly one place to stop, so the scan cannot backtrack.
	// Same survivors, 16% (ascii) / 8% (mixed) less gate time.
	const gap = (i: number): string => `[^${classEscape(points[i])}]*`;
	const subsequenceFrom = (i: number): string => {
		let out = chars[i];
		for (let k = i + 1; k < chars.length; k++) out += `${gap(k)}${chars[k]}`;
		return out;
	};
	const runLength = Math.min(3, chars.length);
	const run = chars.slice(0, runLength).join("");
	const afterRun = runLength < chars.length ? `${gap(runLength)}${subsequenceFrom(runLength)}` : "";
	// Lookbehind rather than a consuming `(?:^|non-word)`: same survivors, ~11%
	// less scan time, and ES2018 sits inside the ES2022 target tsconfig pins.
	return new RegExp(`(?:(?<!${WORD_CLASS})${subsequenceFrom(0)}|${run}${afterRun})`, "u");
};

/**
 * `buildFuzzyGate` for text nothing has normalised yet: each character becomes
 * the class of code points that fold to it, so the gate runs against the
 * caller's own strings and no prepared copy of the corpus has to exist before
 * the first query can filter.
 *
 * Null when the query holds a character the unfold table doesn't cover —
 * non-Latin scripts, mostly. The caller takes the mask path instead; slower,
 * never wrong. No `i` flag: the classes already carry both cases.
 */
export const buildRawGate = (normalisedQuery: string): RegExp | null => {
	const unfold = unfoldTable();
	const classes: string[] = [];
	for (const ch of normalisedQuery) {
		const sources = unfold[ch];
		if (sources === undefined) return null;
		classes.push(classEscape(sources));
	}
	const cls = (i: number): string => `[${classes[i]}]`;
	const gap = (i: number): string => `[^${classes[i]}]*`;
	const subsequenceFrom = (i: number): string => {
		let out = cls(i);
		for (let k = i + 1; k < classes.length; k++) out += `${gap(k)}${cls(k)}`;
		return out;
	};
	const runLength = Math.min(3, classes.length);
	let run = "";
	for (let i = 0; i < runLength; i++) run += cls(i);
	const afterRun =
		runLength < classes.length ? `${gap(runLength)}${subsequenceFrom(runLength)}` : "";
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
export const charMask = (normalised: string): number => {
	let mask = 0;
	for (let i = 0; i < normalised.length; i++) {
		const c = normalised.charCodeAt(i);
		if (c >= 97 && c <= 122) mask |= 1 << (c - 97);
		else if (c >= 48 && c <= 57) mask |= 1 << (26 + (c & 3));
		else if (c > 127) mask |= 1 << (30 + (c & 1));
	}
	return mask;
};

/**
 * Query-side half of the rescue bigram gate, for fields missing exactly one of
 * the query's character classes. Such a field is only reachable by an edit at
 * the query's sole character of the missing class β (two β characters would
 * need two edits), and every rescue-eligible tier is a contiguous occurrence —
 * literal tiers by definition, acronym via consecutive initials — so every
 * query bigram NOT touching the β position must appear in the field's bigram
 * set. `reqLo/reqHi[β]` hold exactly those bigrams; a query with two or more β
 * characters stores all-ones, which no real field mask covers, rejecting the
 * item outright (a hazard-degraded field is all-ones too and still passes).
 *
 * Hash collisions stay false-pass-only in both directions: a required bit that
 * collides with a touching pair's bit is still owed by the intact remainder of
 * the window, and a collision on the field side only adds coverage.
 */
export const buildRescueBigramGate = (
	normalisedQuery: string,
): { reqLo: Int32Array; reqHi: Int32Array } => {
	const n = normalisedQuery.length;
	const cls = new Int32Array(n);
	const classBit = new Int32Array(n).fill(-1);
	for (let p = 0; p < n; p++) {
		const c = normalisedQuery.charCodeAt(p);
		cls[p] = bigramClass(c);
		if (c >= 97 && c <= 122) classBit[p] = c - 97;
		else if (c >= 48 && c <= 57) classBit[p] = 26 + (c & 3);
		else if (c > 127) classBit[p] = 30 + (c & 1);
	}
	const reqLo = new Int32Array(32);
	const reqHi = new Int32Array(32);
	for (let b = 0; b < 32; b++) {
		let positions = 0;
		let at = -1;
		for (let p = 0; p < n; p++) {
			if (classBit[p] === b) {
				positions++;
				at = p;
			}
		}
		if (positions === 0) continue;
		if (positions > 1) {
			reqLo[b] = -1;
			reqHi[b] = -1;
			continue;
		}
		for (let p = 1; p < n; p++) {
			if (cls[p - 1] === 0 || cls[p] === 0 || p - 1 === at || p === at) continue;
			const bit = bigramBit(cls[p - 1], cls[p]);
			if (bit < 32) reqLo[b] |= 1 << bit;
			else reqHi[b] |= 1 << (bit - 32);
		}
	}
	return { reqLo, reqHi };
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
export const buildPresenceGate = (normalisedQuery: string): RegExp => {
	const seen = new Set<string>();
	let src = "^";
	for (const ch of normalisedQuery) {
		if (seen.has(ch) || !wordChar.test(ch)) continue;
		seen.add(ch);
		src += `(?=[^]*${escapeRegex(ch)})`;
	}
	return new RegExp(src);
};

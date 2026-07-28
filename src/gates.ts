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

// One native test for "this field can hold the query as an admissible
// subsequence": the query's positions in order with anything between, anchored
// where the chunk assembler would actually start — a word boundary, or the
// first three positions run consecutively. `matchers[i]` matches position i,
// `gapBodies[i]` is the class body excluded from the gap before it —
// `[^x]*x` leaves the scan exactly one place to stop per step, so it cannot
// backtrack (same survivors, 16%/8% less gate time on ascii/mixed).
// The lookbehind beats a consuming `(?:^|non-word)`: same survivors, ~11%
// less scan time.
const subsequenceGate = (matchers: string[], gapBodies: string[]): RegExp => {
	const gap = (i: number): string => `[^${gapBodies[i]}]*`;
	const subsequenceFrom = (i: number): string => {
		let out = matchers[i];
		for (let k = i + 1; k < matchers.length; k++) out += `${gap(k)}${matchers[k]}`;
		return out;
	};
	const runLength = Math.min(3, matchers.length);
	const run = matchers.slice(0, runLength).join("");
	const afterRun =
		runLength < matchers.length ? `${gap(runLength)}${subsequenceFrom(runLength)}` : "";
	return new RegExp(`(?:(?<!${WORD_CLASS})${subsequenceFrom(0)}|${run}${afterRun})`, "u");
};

/**
 * The fuzzy tier's pre-gate, and for single-word queries the whole ladder's:
 * every earlier tier implies an admissible subsequence too. Requiring the
 * anchor cuts a third of the fields that reach the ladder and cannot
 * false-reject — a field with no admissible first placement has no chain to
 * assemble (@see docs/benchmarks.md).
 *
 * Monotone under query extension, which is what lets the survivor cache in
 * search.ts reuse the previous keystroke's survivors: extending the query
 * lengthens the subsequence and never changes the first three characters, so
 * the gate only ever admits fewer fields.
 */
export const buildFuzzyGate = (normalisedQuery: string): RegExp => {
	const points = [...normalisedQuery];
	return subsequenceGate(points.map(escapeRegex), points.map(classEscape));
};

/**
 * `buildFuzzyGate` for text nothing has normalised yet: each character becomes
 * the class of code points that fold to it, so the gate runs against the
 * caller's own strings before any prepared copy of the corpus exists.
 * Null when the query holds a character the unfold table doesn't cover —
 * non-Latin scripts, mostly — and the caller takes the mask path instead:
 * slower, never wrong. No `i` flag: the classes already carry both cases.
 */
export const buildRawGate = (normalisedQuery: string): RegExp | null => {
	const unfold = unfoldTable();
	const classes: string[] = [];
	for (const ch of normalisedQuery) {
		const sources = unfold[ch];
		if (sources === undefined) return null;
		classes.push(classEscape(sources));
	}
	return subsequenceGate(
		classes.map((sources) => `[${sources}]`),
		classes,
	);
};

/**
 * A 32-bit character-class mask (fuzzysort-style O(1) pre-gate): bits 0–25 for
 * a–z, bits 26–29 for digits (bucketed), bits 30–31 for non-ASCII (bucketed);
 * separators are skipped so they are never required of the field. Query and
 * field use the same buckets, so a collision can only false-pass, never
 * false-reject. `(queryMask & fieldMask) !== queryMask` means some query class
 * is absent and no tier can match.
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
 * so every query bigram NOT touching the β position must appear in the field's
 * bigram set: `reqLo/reqHi[β]` hold exactly those. Two or more β characters
 * store all-ones, which no real field covers (a hazard-degraded field is
 * all-ones too and still passes). Hash collisions stay false-pass-only on both
 * sides: a required bit colliding with a touching pair's is still owed by the
 * intact remainder of the window, and field-side collisions only add coverage.
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

// True when the mask is an exact distinct-char presence check: no lossy bucket
// bits set, so the presence-gate regex could not reject anything further.
export const maskIsExact = (mask: number): boolean => (mask & ~0x3ffffff) === 0;

/**
 * Order-independent presence gate: every distinct word-character of the query
 * must appear somewhere in the field — a necessary condition for every tier.
 * Unlike the subsequence gate it stays valid for out-of-order multi-word
 * matches, and separators are excluded so `"foo bar"` still gates `"bar/foo"`.
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

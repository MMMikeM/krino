import { WORD_CHARS, wordChar } from "./boundaries";
import { bigramBit, bigramClass } from "./normalise";
import { unfoldTable } from "./unfold";

export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Inside a character class only these four are special, and `-` needs escaping
// there while `escapeRegex` leaves it alone.
const escapeCharClass = (text: string): string => text.replace(/[\^\]\\-]/g, "\\$&");

// One query position in the subsequence gate: `matcher` matches the position,
// `gapBody` is the char-class body excluded from the gap before it.
type GatePosition = { matcher: string; gapBody: string };

// One native test for "this field can hold the query as an admissible
// subsequence": the query's positions in order with anything between, anchored
// where the chunk assembler would actually start — a word boundary, or the
// first three positions run consecutively. `[^x]*x` leaves the scan exactly
// one place to stop per step, so it cannot backtrack (same survivors, 16%/8%
// less gate time on ascii/mixed). The lookbehind beats a consuming
// `(?:^|non-word)`: same survivors, ~11% less scan time.
const subsequenceGate = (positions: GatePosition[]): RegExp => {
	const gap = (i: number): string => `[^${positions[i].gapBody}]*`;
	const subsequenceFrom = (i: number): string => {
		let out = positions[i].matcher;
		for (let k = i + 1; k < positions.length; k++) out += `${gap(k)}${positions[k].matcher}`;
		return out;
	};
	const runLength = Math.min(3, positions.length);
	const run = positions
		.slice(0, runLength)
		.map((position) => position.matcher)
		.join("");
	const afterRun =
		runLength < positions.length ? `${gap(runLength)}${subsequenceFrom(runLength)}` : "";
	return new RegExp(`(?:(?<![${WORD_CHARS}])${subsequenceFrom(0)}|${run}${afterRun})`, "u");
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
export const buildFuzzyGate = (normalisedQuery: string): RegExp =>
	subsequenceGate(
		[...normalisedQuery].map((point) => ({
			matcher: escapeRegex(point),
			gapBody: escapeCharClass(point),
		})),
	);

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
	const positions: GatePosition[] = [];
	for (const char of normalisedQuery) {
		const sources = unfold[char];
		if (sources === undefined) return null;
		const gapBody = escapeCharClass(sources);
		positions.push({ matcher: `[${gapBody}]`, gapBody });
	}
	return subsequenceGate(positions);
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
		const unit = normalised.charCodeAt(i);
		if (unit >= 97 && unit <= 122) mask |= 1 << (unit - 97);
		else if (unit >= 48 && unit <= 57) mask |= 1 << (26 + (unit & 3));
		else if (unit > 127) mask |= 1 << (30 + (unit & 1));
	}
	return mask;
};

/**
 * Query-side half of the rescue bigram gate, for fields missing exactly one of
 * the query's character classes. Such a field is only reachable by an edit at
 * the query's sole character of the missing class β (two β characters would
 * need two edits), and every rescue-eligible tier is a contiguous occurrence —
 * so every query bigram NOT touching the β position must appear in the field's
 * bigram set: `requiredLo/requiredHi[β]` hold exactly those. Two or more β
 * characters store all-ones, which no real field covers (a hazard-degraded
 * field is all-ones too and still passes). Hash collisions stay
 * false-pass-only on both sides: a required bit colliding with a touching
 * pair's is still owed by the intact remainder of the window, and field-side
 * collisions only add coverage.
 */
export type RescueBigramGate = { requiredLo: Int32Array; requiredHi: Int32Array };

export const buildRescueBigramGate = (normalisedQuery: string): RescueBigramGate => {
	const queryLength = normalisedQuery.length;
	const bigramClasses = new Int32Array(queryLength);
	const classBit = new Int32Array(queryLength).fill(-1);
	for (let at = 0; at < queryLength; at++) {
		const unit = normalisedQuery.charCodeAt(at);
		bigramClasses[at] = bigramClass(unit);
		if (unit >= 97 && unit <= 122) classBit[at] = unit - 97;
		else if (unit >= 48 && unit <= 57) classBit[at] = 26 + (unit & 3);
		else if (unit > 127) classBit[at] = 30 + (unit & 1);
	}
	const requiredLo = new Int32Array(32);
	const requiredHi = new Int32Array(32);
	for (let b = 0; b < 32; b++) {
		let occurrences = 0;
		let soleAt = -1;
		for (let at = 0; at < queryLength; at++) {
			if (classBit[at] === b) {
				occurrences++;
				soleAt = at;
			}
		}
		if (occurrences === 0) continue;
		if (occurrences > 1) {
			requiredLo[b] = -1;
			requiredHi[b] = -1;
			continue;
		}
		for (let at = 1; at < queryLength; at++) {
			if (
				bigramClasses[at - 1] === 0 ||
				bigramClasses[at] === 0 ||
				at - 1 === soleAt ||
				at === soleAt
			) {
				continue;
			}
			const bit = bigramBit(bigramClasses[at - 1], bigramClasses[at]);
			if (bit < 32) requiredLo[b] |= 1 << bit;
			else requiredHi[b] |= 1 << (bit - 32);
		}
	}
	return { requiredLo, requiredHi };
};

// True when the mask is an exact distinct-char presence check: no lossy bucket
// bits set, so the presence-gate regex could not reject anything further.
export const isExactMask = (mask: number): boolean => (mask & ~0x3ffffff) === 0;

/**
 * Order-independent presence gate: every distinct word-character of the query
 * must appear somewhere in the field — a necessary condition for every tier.
 * Unlike the subsequence gate it stays valid for out-of-order multi-word
 * matches, and separators are excluded so `"foo bar"` still gates `"bar/foo"`.
 */
export const buildPresenceGate = (normalisedQuery: string): RegExp => {
	const seen = new Set<string>();
	let src = "^";
	for (const char of normalisedQuery) {
		if (seen.has(char) || !wordChar.test(char)) continue;
		seen.add(char);
		src += `(?=[^]*${escapeRegex(char)})`;
	}
	return new RegExp(src);
};

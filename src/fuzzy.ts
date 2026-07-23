/**
 * The fuzzy fallback tier: assemble a query out of consecutive-letter chunks
 * found in the field, and score the assembly (fewer, cleaner chunks = lower =
 * better). Chunks must start at a word boundary or run 3+ characters; the
 * query's final 1-2 characters are exempt (they may complete a chunk mid-word,
 * since a shorter-than-3 tail could never satisfy the run rule) and the
 * density floor polices what that leniency can assemble.
 */

import { isValidWordBoundary } from "./shared";
import type { HighlightRanges, Range } from "./types";

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A cheap native gate for the fuzzy tier: the query's characters, in order, with
 * anything between. Both fuzzy strategies require the query to be a subsequence
 * of the field, so a field that fails this test can never match — skip the
 * expensive hand-rolled matcher. Built once per query, tested per field.
 */
export const buildFuzzyGate = (normalizedQuery: string): RegExp =>
	new RegExp([...normalizedQuery].map(escapeRegex).join("[^]*"));

const WORD_CHAR = /[\p{L}\p{N}_]/u;

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
		if (seen.has(ch) || !WORD_CHAR.test(ch)) continue;
		seen.add(ch);
		src += `(?=[^]*${escapeRegex(ch)})`;
	}
	return new RegExp(src);
};

// A consecutive run of matched characters. Same shape as a highlight Range,
// named distinctly because it means "matched run", not "span to highlight".
type Chunk = Range;

// Chunk-scoring constants. BASE equals SCORES.CONTAINS (2) by design — a fuzzy
// match must never beat a true contains — but the two are intentionally NOT the
// same binding, since they mean different things and could diverge.
const CHUNK_SCORES = {
	BASE: 2,
	WHOLE_WORD: 0.2,
	WORD_START: 0.4,
	LONG: 0.8,
	SCATTERED: 1.6,
} as const;

// A fuzzy assembly must cover at least this share of the span it stretches
// across (matched chars ÷ span). Junk chains assembled over long text are
// sparse — measured max 0.143 across both bench corpora at every document
// length — while the sparsest genuine match (initials scattered across a
// four-word name) measures 0.211; 0.18 splits the gap with margin both ways
// (docs/benchmarks.md "Matching inside long text"). This is what keeps `smart`
// safe over document-length fields with no configuration.
const DENSITY_FLOOR = 0.18;

const scoreConsecutiveLetters = (
	chunks: Chunk[],
	normalizedField: string,
): [number, HighlightRanges] | null => {
	let matched = 0;
	for (const [start, end] of chunks) matched += end - start + 1;
	const span = chunks[chunks.length - 1][1] - chunks[0][0] + 1;
	if (matched / span < DENSITY_FLOOR) return null;

	let score = CHUNK_SCORES.BASE;
	for (const [start, end] of chunks) {
		const chunkLen = end - start + 1;
		// Same boundary definition the matcher used to admit the chunk —
		// a chunk admitted because a hyphen is a boundary must not then be
		// priced as if it weren't.
		const isStartOfWord = start === 0 || isValidWordBoundary(normalizedField[start - 1]);
		const isEndOfWord =
			end === normalizedField.length - 1 || isValidWordBoundary(normalizedField[end + 1]);
		if (isStartOfWord && isEndOfWord) score += CHUNK_SCORES.WHOLE_WORD;
		else if (isStartOfWord) score += CHUNK_SCORES.WORD_START;
		else if (chunkLen >= 3) score += CHUNK_SCORES.LONG;
		else score += CHUNK_SCORES.SCATTERED;
	}
	return [score, chunks];
};

export const smartFuzzyMatch = (
	normalizedField: string,
	normalizedQuery: string,
): [number, HighlightRanges] | null => {
	const normalizedFieldLen = normalizedField.length;
	const chunks: Chunk[] = [];
	let queryIdx = 0;
	let queryChar = normalizedQuery[queryIdx];
	let chunkStart = -1;
	let chunkEnd = -2;

	while (true) {
		const idx = normalizedField.indexOf(queryChar, chunkEnd + 1);
		if (idx === -1) break;

		if (idx === 0 || isValidWordBoundary(normalizedField[idx - 1])) {
			chunkStart = idx;
		} else {
			const queryCharsLeft = normalizedQuery.length - queryIdx;
			const fieldCharsLeft = normalizedField.length - idx;
			const minChunkLen = Math.min(3, queryCharsLeft, fieldCharsLeft);
			const minQueryChunk = normalizedQuery.slice(queryIdx, queryIdx + minChunkLen);
			if (normalizedField.slice(idx, idx + minChunkLen) === minQueryChunk) {
				chunkStart = idx;
			} else {
				// Resume the scan after the rejected occurrence. `indexOf`
				// returned the first occurrence at or past the cursor, so
				// nothing between the cursor and `idx` can match; advancing
				// one char at a time instead re-finds the same occurrence
				// per step and turns a far-away reject into O(gap²).
				chunkEnd = idx;
				continue;
			}
		}

		for (chunkEnd = chunkStart; chunkEnd < normalizedFieldLen; chunkEnd++) {
			if (normalizedField[chunkEnd] !== queryChar) break;
			queryIdx++;
			queryChar = normalizedQuery[queryIdx];
		}

		chunkEnd--;
		chunks.push([chunkStart, chunkEnd]);

		if (queryIdx === normalizedQuery.length) {
			return scoreConsecutiveLetters(chunks, normalizedField);
		}
	}
	return null;
};

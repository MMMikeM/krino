/**
 * The fuzzy fallback tier: assemble a query out of consecutive-letter chunks
 * found in the field, and score the assembly (fewer, cleaner chunks = lower =
 * better). Chunks must start at a word boundary or run 3+ characters; the
 * query's final 1-2 characters are exempt (they may complete a chunk mid-word,
 * since a shorter-than-3 tail could never satisfy the run rule) and the
 * density floor polices what that leniency can assemble.
 */

import { isBoundaryChar } from "./boundaries";
import type { HighlightRanges, Range } from "./types";

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
// (docs/benchmarks.md "Matching inside long text"). This is what keeps the
// fuzzy tier safe over document-length fields with no configuration.
const DENSITY_FLOOR = 0.18;

const scoreChunks = (
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
		const isStartOfWord = start === 0 || isBoundaryChar(normalizedField[start - 1]);
		const isEndOfWord =
			end === normalizedField.length - 1 || isBoundaryChar(normalizedField[end + 1]);
		if (isStartOfWord && isEndOfWord) score += CHUNK_SCORES.WHOLE_WORD;
		else if (isStartOfWord) score += CHUNK_SCORES.WORD_START;
		else if (chunkLen >= 3) score += CHUNK_SCORES.LONG;
		else score += CHUNK_SCORES.SCATTERED;
	}
	return [score, chunks];
};

export const fuzzyChainMatch = (
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

		if (idx === 0 || isBoundaryChar(normalizedField[idx - 1])) {
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
			return scoreChunks(chunks, normalizedField);
		}
	}
	return null;
};

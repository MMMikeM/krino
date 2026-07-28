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
	normalisedField: string,
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
		const isStartOfWord = start === 0 || isBoundaryChar(normalisedField[start - 1]);
		const isEndOfWord =
			end === normalisedField.length - 1 || isBoundaryChar(normalisedField[end + 1]);
		if (isStartOfWord && isEndOfWord) score += CHUNK_SCORES.WHOLE_WORD;
		else if (isStartOfWord) score += CHUNK_SCORES.WORD_START;
		else if (chunkLen >= 3) score += CHUNK_SCORES.LONG;
		else score += CHUNK_SCORES.SCATTERED;
	}
	return [score, chunks];
};

// Whether a chunk may start at `idx`, consuming the query from `queryIdx`:
// either it opens a word, or it runs 3+ characters (short tails exempt, since a
// query with fewer than 3 characters left could never satisfy the run rule).
const admitsChunk = (
	normalisedField: string,
	normalisedQuery: string,
	idx: number,
	queryIdx: number,
): boolean => {
	if (idx === 0 || isBoundaryChar(normalisedField[idx - 1])) return true;
	const queryCharsLeft = normalisedQuery.length - queryIdx;
	const fieldCharsLeft = normalisedField.length - idx;
	const minChunkLen = Math.min(3, queryCharsLeft, fieldCharsLeft);
	return normalisedField.startsWith(normalisedQuery.slice(queryIdx, queryIdx + minChunkLen), idx);
};

// Assemble the whole query starting from a chunk at `start` (already admitted),
// taking the leftmost admissible placement for every later chunk. Returns null
// if the chain dead-ends before consuming the query.
const chainFrom = (
	normalisedField: string,
	normalisedQuery: string,
	start: number,
): Chunk[] | null => {
	const normalisedFieldLen = normalisedField.length;
	const normalisedQueryLen = normalisedQuery.length;
	const chunks: Chunk[] = [];
	let queryIdx = 0;
	let queryChar = normalisedQuery[queryIdx];
	let chunkStart = start;

	while (true) {
		// The chunk start is a known occurrence of queryChar, so this always
		// consumes at least one character and chunkEnd lands at or after it.
		let chunkEnd = chunkStart;
		while (chunkEnd < normalisedFieldLen && normalisedField[chunkEnd] === queryChar) {
			queryIdx++;
			queryChar = normalisedQuery[queryIdx];
			chunkEnd++;
		}
		chunkEnd--;
		chunks.push([chunkStart, chunkEnd]);

		if (queryIdx === normalisedQueryLen) return chunks;

		// Resume the scan after each rejected occurrence. `indexOf` returned the
		// first occurrence at or past the cursor, so nothing between the cursor
		// and `idx` can match; advancing one char at a time instead re-finds the
		// same occurrence per step and turns a far-away reject into O(gap²).
		let idx = normalisedField.indexOf(queryChar, chunkEnd + 1);
		while (idx > -1 && !admitsChunk(normalisedField, normalisedQuery, idx, queryIdx)) {
			idx = normalisedField.indexOf(queryChar, idx + 1);
		}
		if (idx === -1) return null;
		chunkStart = idx;
	}
};

// How many placements of the *first* chunk the assembly may try. This bound is
// a correctness guard, not a speed knob: the density floor is a ratio, so a
// compact assembly ("madel" + "ine") clears it at any field length, and the only
// reason junk chains used to be rejected over long text is that a single
// leftmost-greedy attempt stretched them into a sparse span. Every extra attempt
// is another chance to hit a dense coincidence, so an unbounded search makes the
// junk rate climb with field length — the exact v1 failure the floor exists to
// prevent. A fixed cap keeps the number of attempts independent of field length.
// Measured over the ascii bench corpus (chain-level probes) and the mixed
// long-text probes at 64…16384 chars (bench/longtext.test.ts):
//
//   attempts | missed | suboptimal | junk hits
//   1 (was)  |    307 |        131 |         0
//   3        |      0 |         31 |         0
//   4        |      0 |         30 |         0
//   8        |      0 |         30 |         4
//   ∞        |      0 |         30 |        43
//
// 4 buys everything an unbounded search does — the residual 30 are later-chunk
// placements no first-chunk retry can reach — while staying clear of the leak.
const MAX_CHUNK_STARTS = 4;

export const fuzzyChainMatch = (
	normalisedField: string,
	normalisedQuery: string,
): [number, HighlightRanges] | null => {
	// Retry the assembly from the first few admissible placements of the first
	// chunk and keep the cheapest. Taking only the leftmost one strands the
	// chain whenever the query's first character also opens an earlier word —
	// the common shape in natural-language fields ("towls" over "Tasty Silk
	// Towels" hits the T of "Tasty") — which either misses outright or pays for
	// a lone 1-character chunk it never needed. Later chunks stay
	// leftmost-greedy: the first chunk is where the corpus showed the divergence
	// to be, and reconsidering those too is what starts leaking junk.
	const firstChar = normalisedQuery[0];
	let best: [number, HighlightRanges] | null = null;
	let starts = 0;

	for (
		let start = normalisedField.indexOf(firstChar);
		start > -1;
		start = normalisedField.indexOf(firstChar, start + 1)
	) {
		if (!admitsChunk(normalisedField, normalisedQuery, start, 0)) continue;
		if (++starts > MAX_CHUNK_STARTS) break;
		const chunks = chainFrom(normalisedField, normalisedQuery, start);
		if (chunks === null) continue;
		const scored = scoreChunks(chunks, normalisedField);
		if (scored !== null && (best === null || scored[0] < best[0])) best = scored;
	}
	return best;
};

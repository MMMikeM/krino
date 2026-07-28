import { isBoundaryChar } from "./boundaries";
import type { HighlightRanges, Range } from "./types";

// Same shape as a highlight Range, named for what it means here: a consecutive
// run of matched characters.
type Chunk = Range;

// BASE equals SCORES.CONTAINS (2) by design — a fuzzy match must never beat a
// true contains — but intentionally NOT the same binding: they mean different
// things and could diverge.
const CHUNK_SCORES = {
	BASE: 2,
	WHOLE_WORD: 0.2,
	WORD_START: 0.4,
	LONG: 0.8,
	SCATTERED: 1.6,
} as const;

// Matched chars ÷ spanned chars. Junk chains over long text measured at most
// 0.143; the sparsest genuine match measured 0.211; 0.18 splits the gap with
// margin both ways (@see docs/benchmarks.md "Matching inside long text"). This
// is what keeps the fuzzy tier safe over document-length fields.
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
		// Same boundary definition admitsChunk used — a chunk admitted because a
		// hyphen is a boundary must not then be priced as if it weren't.
		const opensWord = start === 0 || isBoundaryChar(normalisedField[start - 1]);
		const closesWord =
			end === normalisedField.length - 1 || isBoundaryChar(normalisedField[end + 1]);
		if (opensWord && closesWord) score += CHUNK_SCORES.WHOLE_WORD;
		else if (opensWord) score += CHUNK_SCORES.WORD_START;
		else if (end - start + 1 >= 3) score += CHUNK_SCORES.LONG;
		else score += CHUNK_SCORES.SCATTERED;
	}
	return [score, chunks];
};

// A chunk may start mid-word only by running 3+ characters; short query tails
// are exempt, since fewer than 3 remaining characters could never satisfy it.
const admitsChunk = (
	normalisedField: string,
	normalisedQuery: string,
	at: number,
	queryFrom: number,
): boolean => {
	if (at === 0 || isBoundaryChar(normalisedField[at - 1])) return true;
	const queryCharsLeft = normalisedQuery.length - queryFrom;
	const fieldCharsLeft = normalisedField.length - at;
	const minChunkLength = Math.min(3, queryCharsLeft, fieldCharsLeft);
	return normalisedField.startsWith(
		normalisedQuery.slice(queryFrom, queryFrom + minChunkLength),
		at,
	);
};

// Assemble the whole query from a chunk at `start` (already admitted), taking
// the leftmost admissible placement for every later chunk; null when the chain
// dead-ends.
const chainFrom = (
	normalisedField: string,
	normalisedQuery: string,
	start: number,
): Chunk[] | null => {
	const chunks: Chunk[] = [];
	let queryAt = 0;
	let queryChar = normalisedQuery[queryAt];
	let chunkStart = start;

	while (true) {
		let chunkEnd = chunkStart;
		while (chunkEnd < normalisedField.length && normalisedField[chunkEnd] === queryChar) {
			queryAt++;
			queryChar = normalisedQuery[queryAt];
			chunkEnd++;
		}
		chunks.push([chunkStart, chunkEnd - 1]);

		if (queryAt === normalisedQuery.length) return chunks;

		// indexOf from past each rejected occurrence, never one char at a time —
		// stepping would re-find the same occurrence per step and turn a far-away
		// reject into O(gap²).
		let at = normalisedField.indexOf(queryChar, chunkEnd);
		while (at > -1 && !admitsChunk(normalisedField, normalisedQuery, at, queryAt)) {
			at = normalisedField.indexOf(queryChar, at + 1);
		}
		if (at === -1) return null;
		chunkStart = at;
	}
};

// A correctness guard, not a speed knob: the density floor is a ratio, so every
// extra first-chunk attempt is another chance for junk to assemble a dense
// coincidence, and an unbounded search makes the junk rate climb with field
// length. 4 buys everything an unbounded search does while staying clear of the
// leak — measured table in docs/performance.md "Bounded chunk-start retries".
const MAX_CHUNK_STARTS = 4;

// Retry the assembly from the first few admissible placements of the first
// chunk and keep the cheapest: leftmost-only strands the chain whenever the
// query's first character also opens an earlier word ("towls" over "Tasty Silk
// Towels" hits the T of "Tasty"). Later chunks stay leftmost-greedy —
// reconsidering those too is what starts leaking junk.
export const fuzzyChainMatch = (
	normalisedField: string,
	normalisedQuery: string,
): [number, HighlightRanges] | null => {
	const firstChar = normalisedQuery[0];
	let best: [number, HighlightRanges] | null = null;
	let attempts = 0;

	for (
		let start = normalisedField.indexOf(firstChar);
		start > -1;
		start = normalisedField.indexOf(firstChar, start + 1)
	) {
		if (!admitsChunk(normalisedField, normalisedQuery, start, 0)) continue;
		if (++attempts > MAX_CHUNK_STARTS) break;
		const chunks = chainFrom(normalisedField, normalisedQuery, start);
		if (chunks === null) continue;
		const scored = scoreChunks(chunks, normalisedField);
		if (scored !== null && (best === null || scored[0] < best[0])) best = scored;
	}
	return best;
};

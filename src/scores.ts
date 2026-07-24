/**
 * The tier ladder as named constants. Lower = better. Any score greater than
 * CONTAINS is a fuzzy-fallback match (see fuzzy.ts) or a deep transposition
 * rescue (tier "transposed", up to CONTAINS + TRANSPOSED_PENALTY). Exported so
 * callers can filter or re-rank by tier without hardcoding magic numbers.
 */
export const SCORES = {
	EXACT: 0,
	NORMALIZED_EXACT: 0.1,
	PREFIX: 0.5,
	BOUNDARY_EXACT: 0.9,
	BOUNDARY: 1,
	MULTI_WORD: 1.5,
	ACRONYM: 1.8,
	CONTAINS: 2,
} as const;

// Added to the corrected query's score when the transposition rescue fires
// (tier "transposed"). Sized so a rescued boundary hit (1 + 0.9) stays under a
// true contains (2) — a typo correction never outranks a genuine tier hit at
// its level. Only a rescued contains (2.9) lands inside the fuzzy band's
// numeric range; the tier field is what tells those apart.
export const TRANSPOSED_PENALTY = 0.9;

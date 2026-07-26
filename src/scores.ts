/**
 * The tier ladder as named constants. Lower = better. Any score greater than
 * CONTAINS is a fuzzy-fallback match (see fuzzy.ts) or a one-edit typo rescue
 * (see TYPO_PENALTY) — every genuine tier is at or below CONTAINS, so that
 * constant is the dividing line between a literal match and a speculative one.
 * Exported so callers can filter or re-rank by tier without hardcoding magic
 * numbers.
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

// Added to the corrected query's score when a one-edit rescue fires (tier
// "corrected").
//
// Sized so the BEST possible correction — a corrected exact hit, 0 + 2.1 —
// still sorts below the WEAKEST genuine tier, CONTAINS (2). A correction is a
// guess about what the user meant; a substring match is something they actually
// typed, so the literal hit wins every time. Sizing this below 2 inverts that,
// and it is measurable: at 0.9 an infix query's intended item fell from MRR
// 0.973 to 0.906, because other items' typo corrections displaced it.
//
// Rescued scores therefore land at 2.1 and up, overlapping the fuzzy band
// numerically; the tier field is what tells them apart.
//
// One penalty for every kind of edit: they are the same edit distance, and
// pricing them differently would rank a swapped keystroke above a dropped one
// on no evidence.
export const TYPO_PENALTY = 2.1;

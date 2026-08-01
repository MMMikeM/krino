/**
 * Krino — tiny, typed fuzzy matching. Inspired by @nozbe/microfuzz.
 *
 * Scoring is lower = better. `score <= SCORES.CONTAINS` is the test for "the
 * user's text actually appears here"; above it is a fuzzy chain or a one-edit
 * typo rescue, and only `tier` tells those apart.
 */

export { createFuzzySearch, fuzzyMatch } from "./search";
export { splitWords } from "./boundaries";
export { normaliseText } from "./normalise";
export { SCORES, TYPO_PENALTY } from "./scores";
export type * from "./types";

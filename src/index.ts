/**
 * Krino — tiny, typed fuzzy matching. Inspired by @nozbe/microfuzz.
 *
 * Two entry points:
 * - `fuzzyMatch(text, query, options?)` — the primitive: score one string,
 *   returning `{ score, tier, ranges }`.
 * - `createFuzzySearch(list, getText? | fields?)` — a cached, sorted search over
 *   a collection.
 *
 * Scoring is lower = better; see the `SCORES` constants and the `Tier` type.
 * Any score greater than `SCORES.CONTAINS` is tier "fuzzy".
 */

export { createFuzzySearch, fuzzyMatch } from "./search";
export { splitWords } from "./boundaries";
export { normalizeText } from "./normalize";
export { SCORES } from "./scores";
export type * from "./types";

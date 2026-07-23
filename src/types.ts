/**
 * Range of indices in a string: [start, end] (inclusive)
 */
export type Range = [number, number];

/**
 * List of character ranges that should be highlighted
 */
export type HighlightRanges = Range[];

/**
 * Fuzzy match strategy (selects the fuzzy fallback tier):
 * - 'off': no fuzzy matching, only exact/prefix/boundary/contains
 * - 'smart': matches at word boundaries or 3+ char chunks (default)
 */
export type Strategy = "off" | "smart";

/**
 * Which tier a match came from. Lower on this list is a weaker match; a `score`
 * greater than SCORES.CONTAINS is always tier "fuzzy".
 */
export type Tier =
	| "exact"
	| "normalized-exact"
	| "prefix"
	| "boundary-exact"
	| "boundary"
	| "multi-word"
	| "acronym"
	| "contains"
	| "fuzzy";

/**
 * The result of matching one string against a query.
 * Lower score = better match (think "error level").
 */
export type MatchResult = {
	score: number;
	tier: Tier;
	ranges: HighlightRanges;
};

/**
 * Options for the fuzzyMatch primitive.
 */
export type MatchOptions = {
	/** Fuzzy fallback strategy (default: 'smart'). */
	strategy?: Strategy;
	/** Enable the acronym (word-initials) tier (default: false). */
	acronym?: boolean;
};

/**
 * One searchable field of an item, with its matching configuration.
 */
export type FieldSpec<T = unknown> = {
	/** Extract this field's text from an item (null → this field is skipped). */
	text: (item: T) => string | null;
	/** Fuzzy strategy for this field (default: 'smart'). */
	strategy?: Strategy;
	/** Enable the acronym tier for this field (default: false). */
	acronym?: boolean;
	/** Added to this field's score; higher demotes it (default: 0, keep >= 0).
	 *  e.g. `penalty: SCORES.CONTAINS` keeps this field below better tiers elsewhere. */
	penalty?: number;
};

/**
 * A ranked search result for one collection item.
 */
export type FuzzyResult<T> = {
	item: T;
	/** Best (minimum) effective score across the item's fields. */
	score: number;
	/** Per-field match, null where that field didn't match. */
	fields: Array<MatchResult | null>;
};

/**
 * A prepared fuzzy search function.
 */
export type FuzzySearcher<T> = (query: string) => Array<FuzzyResult<T>>;

/**
 * Range of indices in a string: [start, end] (inclusive)
 */
export type Range = [number, number];

/**
 * List of character ranges that should be highlighted
 */
export type HighlightRanges = Range[];

/**
 * Which tier a match came from. Lower on this list is a weaker match; a `score`
 * greater than SCORES.CONTAINS is a fuzzy chain or a deep transposition rescue
 * (a rescued contains is 2.9) — the tier tells them apart.
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
	| "fuzzy"
	| "transposed";

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
	/** Enable the acronym (word-initials) tier (default: false). */
	acronym?: boolean;
};

/**
 * One searchable field of an item, with its matching configuration.
 */
export type FieldSpec<T = unknown> = {
	/** Extract this field's text from an item (null → this field is skipped). */
	text: (item: T) => string | null;
	/** Enable the acronym tier for this field (default: false). */
	acronym?: boolean;
	/** Added to this field's score; higher demotes it (default: 0, keep >= 0).
	 *  e.g. `atBest: SCORES.CONTAINS` keeps this field below better tiers elsewhere. */
	atBest?: number;
};

/**
 * A ranked search result for one collection item.
 */
export type FuzzyResult<T> = {
	item: T;
	/** Best (minimum) effective score across the item's fields. */
	score: number;
	/** Per-field match, null where that field didn't match. */
	fields: (MatchResult | null)[];
};

/**
 * A prepared fuzzy search function.
 */
export type FuzzySearcher<T> = (query: string) => FuzzyResult<T>[];

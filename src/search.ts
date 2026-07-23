/**
 * Public search entry points:
 * - `fuzzyMatch` — the primitive: score one string against a query.
 * - `createFuzzySearch` — a preprocessing-cached, sorted search over a collection,
 *   built on the primitive. Second arg is a `getText` fn or an array of field specs.
 */

import { buildFuzzyGate, buildPresenceGate, charMask } from "./fuzzy";
import { matchField, type MatchQuery } from "./match";
import { normalizeText, splitWords } from "./normalize";
import type {
	FieldSpec,
	FuzzyResult,
	FuzzySearcher,
	MatchOptions,
	MatchResult,
} from "./types";

const { MAX_SAFE_INTEGER } = Number;

const sortByScore = <T>(a: FuzzyResult<T>, b: FuzzyResult<T>): number => a.score - b.score;

// Build the query-derived state once, reused across every field.
const prepareQuery = (query: string, normalizedQuery: string): MatchQuery => {
	const queryMask = charMask(normalizedQuery);
	return {
		query,
		normalizedQuery,
		queryWords: splitWords(normalizedQuery),
		queryMask,
		// No digit/non-ASCII bucket bits (26+) means the mask is an exact
		// distinct-char check, making the presence regex redundant.
		presenceGateRedundant: (queryMask & ~0x3ffffff) === 0,
		presenceGate: buildPresenceGate(normalizedQuery),
		fuzzyGate: buildFuzzyGate(normalizedQuery),
	};
};

/**
 * Score one string against a query. Returns { score, tier, ranges } or null.
 */
export const fuzzyMatch = (
	text: string,
	query: string,
	options: MatchOptions = {},
): MatchResult | null => {
	const { acronym = false } = options;
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery.length) return null;

	const q = prepareQuery(query, normalizedQuery);
	const normalizedField = normalizeText(text);

	return matchField(text, normalizedField, charMask(normalizedField), q, acronym);
};

// A preprocessed field: its cached normalized form plus its matching config.
type PreparedField = {
	field: string;
	normalizedField: string;
	mask: number;
	acronym: boolean;
	atBest: number;
};

const prepareField = (
	text: string | null,
	acronym: boolean,
	atBest: number,
): PreparedField => {
	const field = text || "";
	const normalizedField = normalizeText(field);
	return {
		field,
		normalizedField,
		mask: charMask(normalizedField),
		acronym,
		atBest,
	};
};

/**
 * Creates a fuzzy search function for a collection.
 *
 * @example
 * // Array of strings
 * const search = createFuzzySearch(['apple', 'banana']);
 * search('ban'); // [{ item: 'banana', score: 0.5, fields: [{ score: 0.5, tier: 'prefix', ranges: [[0, 2]] }] }]
 *
 * @example
 * // Objects, one field
 * const search = createFuzzySearch(users, (u) => u.name);
 *
 * @example
 * // Multiple fields, per-field config (body never outranks title)
 * const search = createFuzzySearch(posts, [
 *   { text: (p) => p.title },
 *   { text: (p) => p.body, atBest: SCORES.CONTAINS },
 * ]);
 */
export function createFuzzySearch(list: string[]): FuzzySearcher<string>;
export function createFuzzySearch<T>(
	list: T[],
	getText: (item: T) => string | null,
): FuzzySearcher<T>;
export function createFuzzySearch<T>(list: T[], fields: FieldSpec<T>[]): FuzzySearcher<T>;
export function createFuzzySearch<T>(
	list: T[],
	extract?: ((item: T) => string | null) | FieldSpec<T>[],
): FuzzySearcher<T> {
	const specs: FieldSpec<T>[] = !extract
		? [{ text: (item) => item as unknown as string }]
		: typeof extract === "function"
			? [{ text: extract }]
			: extract;

	const count = list.length;
	const preparedFields: PreparedField[][] = [];
	// Per-item union of field masks in a typed array, so the reject scan reads 4
	// bytes per item instead of chasing object properties. The union can only
	// false-pass (some field may still miss a class); matchField's per-field mask
	// check keeps multi-field correctness.
	const unionMasks = new Int32Array(count);
	for (let i = 0; i < count; i++) {
		const item = list[i] as T;
		const prepared = specs.map((s) =>
			prepareField(s.text(item), s.acronym ?? false, s.atBest ?? 0),
		);
		preparedFields.push(prepared);
		let union = 0;
		for (const p of prepared) union |= p.mask;
		unionMasks[i] = union;
	}

	// Prefix-narrowing cache. When the new query extends the previous one (the
	// common case while typing), only the previous mask-gate survivors need
	// rescanning: extending a query only adds mask bits, so an item rejected by
	// the shorter query's mask stays rejected. Survivors are the mask-pass set,
	// NOT the match set — the match set is not monotone under extension (a field
	// can match "fox brown" via the multi-word tier while failing "fox brow"),
	// but every tier requires the query's character classes, so all matches of
	// the extended query lie inside the previous mask-pass set.
	let cachedQuery = "";
	let cachedSurvivors: Int32Array | null = null;
	let cachedCount = 0;

	return (query: string) => {
		const normalizedQuery = normalizeText(query);
		if (!normalizedQuery.length) return [];

		const q = prepareQuery(query, normalizedQuery);
		const queryMask = q.queryMask;

		const narrowed = cachedSurvivors !== null && normalizedQuery.startsWith(cachedQuery);
		const source = narrowed ? cachedSurvivors : null;
		const bound = narrowed ? cachedCount : count;

		const survivors = new Int32Array(bound);
		let survivorCount = 0;
		const results: Array<FuzzyResult<T>> = [];

		for (let k = 0; k < bound; k++) {
			const i = source ? (source[k] as number) : k;
			if ((queryMask & (unionMasks[i] as number)) !== queryMask) continue;
			survivors[survivorCount++] = i;

			const prepared = preparedFields[i] as PreparedField[];
			let bestScore = MAX_SAFE_INTEGER;
			let fields: Array<MatchResult | null> | null = null;

			for (let f = 0; f < prepared.length; f++) {
				const p = prepared[f] as PreparedField;
				const result = matchField(p.field, p.normalizedField, p.mask, q, p.acronym);
				if (result) {
					const effective = { ...result, score: result.score + p.atBest };
					bestScore = Math.min(bestScore, effective.score);
					(fields ??= prepared.map(() => null))[f] = effective;
				}
			}

			if (fields) {
				results.push({ item: list[i] as T, score: bestScore, fields });
			}
		}

		cachedQuery = normalizedQuery;
		cachedSurvivors = survivors;
		cachedCount = survivorCount;

		return results.sort(sortByScore);
	};
}

/**
 * Public search entry points:
 * - `fuzzyMatch` — the primitive: score one string against a query.
 * - `createFuzzySearch` — a preprocessing-cached, sorted search over a collection,
 *   built on the primitive. Second arg is a `getText` fn or an array of field specs.
 */

import { buildFuzzyGate, buildPresenceGate, charMask, maskIsExact } from "./gates";
import { matchField, type PreparedQuery } from "./match";
import { splitWords } from "./boundaries";
import { normalizeText } from "./normalize";
import type { FieldSpec, FuzzyResult, FuzzySearcher, MatchOptions, MatchResult } from "./types";

const { MAX_SAFE_INTEGER } = Number;

const sortByScore = <T>(a: FuzzyResult<T>, b: FuzzyResult<T>): number => a.score - b.score;

const toNullField = (): null => null;

// Shift ranges from trimmed-field space into the caller's raw string. Only
// leading whitespace shifts offsets; matchField returns fresh Range tuples per
// call, so mutating in place is safe.
const shiftRanges = (ranges: [number, number][], lead: number): void => {
	for (const r of ranges) {
		r[0] += lead;
		r[1] += lead;
	}
};

// Build the query-derived state once, reused across every field. The raw query
// is stored trimmed so the exact-case tiers treat padding as insignificant,
// matching the normalized tiers (normalizeText trims).
const prepareQuery = (query: string, normalizedQuery: string): PreparedQuery => {
	const queryMask = charMask(normalizedQuery);
	const queryWords = splitWords(normalizedQuery);
	// The presence gate only ever front-gates multi-word queries, and only when
	// the mask can't already prove exact char presence; everything else skips
	// its construction entirely.
	const needsPresenceGate = queryWords.length > 1 && !maskIsExact(queryMask);
	return {
		query: query.trim(),
		normalizedQuery,
		queryWords,
		queryMask,
		presenceGate: needsPresenceGate ? buildPresenceGate(normalizedQuery) : null,
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
	const field = text.trim();
	const normalizedField = normalizeText(field);

	const result = matchField(field, normalizedField, charMask(normalizedField), q, acronym);
	const lead = text.length - text.trimStart().length;
	if (result && lead) shiftRanges(result.ranges, lead);
	return result;
};

// A preprocessed field: its cached normalized form plus its matching config.
// Per-item, per-field cached strings. Everything else that used to live here
// was hoisted: `acronym`/`atBest` are per-spec constants (they were being
// copied into every item × field object), and the per-field masks live in one
// flat Int32Array alongside `unionMasks`.
type PreparedField = {
	field: string; // trimmed raw — ranges are shifted back by `lead` per hit
	normalizedField: string;
	lead: number; // leading-whitespace units stripped from the raw field
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

	// Spec defaults resolved once; the per-item loop below runs count × specs
	// times and shouldn't re-default options or capture per-item closures.
	const resolvedSpecs = specs.map((s) => ({
		text: s.text,
		acronym: s.acronym ?? false,
		atBest: s.atBest ?? 0,
	}));
	const specCount = resolvedSpecs.length;

	const count = list.length;
	const preparedFields: PreparedField[][] = [];
	// Per-item union of field masks in a typed array, so the reject scan reads 4
	// bytes per item instead of chasing object properties. The union can only
	// false-pass (some field may still miss a class); matchField's per-field mask
	// check keeps multi-field correctness. The per-field masks sit in one flat
	// Int32Array (item-major, `i * specCount + f`) rather than on the objects.
	const unionMasks = new Int32Array(count);
	const fieldMasks = new Int32Array(count * specCount);
	for (let i = 0; i < count; i++) {
		const item = list[i];
		const prepared: PreparedField[] = [];
		let union = 0;
		for (let f = 0; f < specCount; f++) {
			const raw = resolvedSpecs[f].text(item) || "";
			const field = raw.trim();
			const normalizedField = normalizeText(field);
			const mask = charMask(normalizedField);
			prepared.push({ field, normalizedField, lead: raw.length - raw.trimStart().length });
			fieldMasks[i * specCount + f] = mask;
			union |= mask;
		}
		preparedFields.push(prepared);
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
	// The two survivor lists are double-buffered: `cachedSurvivors` holds the
	// previous query's mask-pass set while `spare` receives the current one,
	// then they swap. Reusing the pair keeps the query path allocation-free
	// (a fresh 100k Int32Array costs ~65 µs of alloc + zeroing per keystroke).
	let cachedQuery = "";
	let cachedSurvivors: Int32Array | null = null;
	let spare: Int32Array | null = null;
	let cachedCount = 0;

	return (query: string) => {
		const normalizedQuery = normalizeText(query);
		if (!normalizedQuery.length) return [];

		const q = prepareQuery(query, normalizedQuery);
		const { queryMask } = q;

		const narrowed = cachedSurvivors !== null && normalizedQuery.startsWith(cachedQuery);
		const source = narrowed ? cachedSurvivors : null;
		const scanCount = narrowed ? cachedCount : count;

		const survivors = (spare ??= new Int32Array(count));
		let survivorCount = 0;
		const results: FuzzyResult<T>[] = [];

		for (let k = 0; k < scanCount; k++) {
			const i = source ? source[k] : k;
			if ((queryMask & unionMasks[i]) !== queryMask) continue;
			survivors[survivorCount++] = i;

			const prepared = preparedFields[i];
			const maskBase = i * specCount;
			let bestScore = MAX_SAFE_INTEGER;
			let fields: (MatchResult | null)[] | null = null;

			for (let f = 0; f < specCount; f++) {
				const p = prepared[f];
				const s = resolvedSpecs[f];
				const result = matchField(p.field, p.normalizedField, fieldMasks[maskBase + f], q, s.acronym);
				if (result) {
					// matchField returns a fresh object per call, so the atBest
					// shift can mutate it instead of spreading a copy.
					result.score += s.atBest;
					if (p.lead) shiftRanges(result.ranges, p.lead);
					bestScore = Math.min(bestScore, result.score);
					(fields ??= prepared.map(toNullField))[f] = result;
				}
			}

			if (fields) {
				results.push({ item: list[i], score: bestScore, fields });
			}
		}

		cachedQuery = normalizedQuery;
		spare = cachedSurvivors; // the retired previous list becomes the next scratch buffer
		cachedSurvivors = survivors;
		cachedCount = survivorCount;

		return results.sort(sortByScore);
	};
}

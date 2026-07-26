/**
 * Public search entry points:
 * - `fuzzyMatch` — the primitive: score one string against a query.
 * - `createFuzzySearch` — a preprocessing-cached, sorted search over a collection,
 *   built on the primitive. Second arg is a `getText` fn or an array of field specs.
 */

import { LAZY_FIELDS } from "./flags";
import { charMask } from "./gates";
import { admitsMissingClass, matchField, prepareQuery } from "./match";
import { normalizeText, rawCharMask } from "./normalize";
import { SCORES } from "./scores";
import type { FieldSpec, FuzzyResult, FuzzySearcher, MatchOptions, MatchResult } from "./types";

const { MAX_SAFE_INTEGER } = Number;

// How many literal-tier hits stop the one-edit rescue from being attempted on
// later items. Ten because that is the slice a picker shows, and the same
// cutoff the published MRR uses; a correction that cannot reach the top ten is
// work no caller can observe through the ranking.
const RESCUE_BUDGET = 10;

const sortByScore = <T>(a: FuzzyResult<T>, b: FuzzyResult<T>): number => a.score - b.score;

// Shift ranges from trimmed-field space into the caller's raw string. Only
// leading whitespace shifts offsets; matchField returns fresh Range tuples per
// call, so mutating in place is safe.
const shiftRanges = (ranges: [number, number][], lead: number): void => {
	for (const r of ranges) {
		r[0] += lead;
		r[1] += lead;
	}
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
	field: string; // trimmed raw — ranges are shifted back per hit when a lead exists
	normalizedField: string;
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
	// Filled on first mask survival, indexed item-major like fieldMasks. Two flat
	// arrays rather than objects: the survivors of one query are a few percent of
	// the corpus, and they recur across keystrokes, so this warms to the working
	// set instead of the whole list.
	// oxlint-disable-next-line unicorn/no-new-array
	const lazyRaw: (string | undefined)[] = LAZY_FIELDS ? new Array(count * specCount) : [];
	// oxlint-disable-next-line unicorn/no-new-array
	const lazyNorm: (string | undefined)[] = LAZY_FIELDS ? new Array(count * specCount) : [];
	// Per-item union of field masks in a typed array, so the reject scan reads 4
	// bytes per item instead of chasing object properties. The union can only
	// false-pass (some field may still miss a class); matchField's per-field mask
	// check keeps multi-field correctness. The per-field masks sit in one flat
	// Int32Array (item-major, `i * specCount + f`) rather than on the objects.
	const unionMasks = new Int32Array(count);
	const fieldMasks = new Int32Array(count * specCount);
	// Leading-whitespace shifts, allocated only if any field actually has one
	// (real data virtually never does): a number slot on every PreparedField
	// would cost ~8 B × count × specs for a value that is almost always 0.
	let leads: Int32Array | null = null;
	for (let i = 0; i < count; i++) {
		const item = list[i];
		const prepared: PreparedField[] = [];
		let union = 0;
		for (let f = 0; f < specCount; f++) {
			const raw = resolvedSpecs[f].text(item) || "";
			// The mask is the only thing every item needs, and it folds straight
			// out of the raw string: no trim, no normalise, no allocation. Even
			// `lead` waits — it is read only for items that produce a result.
			const mask = LAZY_FIELDS ? rawCharMask(raw) : charMask(normalizeText(raw.trim()));
			if (!LAZY_FIELDS) {
				const lead = raw.length - raw.trimStart().length;
				if (lead) (leads ??= new Int32Array(count * specCount))[i * specCount + f] = lead;
				const field = raw.trim();
				const normalizedField = normalizeText(field);
				prepared.push({ field, normalizedField });
			}
			fieldMasks[i * specCount + f] = mask;
			union |= mask;
		}
		if (!LAZY_FIELDS) preparedFields.push(prepared);
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
	//
	// That monotonicity holds per gate, and the gate is not fixed — it relaxes
	// for rescuable queries. Narrowing is only sound when the current gate is no
	// more permissive than the one that built the cache, which `cachedRelaxed`
	// records.
	let cachedQuery = "";
	let cachedRelaxed = false;
	let cachedSurvivors: Int32Array | null = null;
	let spare: Int32Array | null = null;
	let cachedCount = 0;

	return (query: string) => {
		const normalizedQuery = normalizeText(query);
		if (!normalizedQuery.length) return [];

		const q = prepareQuery(query, normalizedQuery);
		const { queryMask } = q;
		// Same predicate matchField's mask gate uses, so the two cannot drift.
		// It stays a flat query-length test rather than the rescue's
		// field-scaled floor because this scan reads one union mask per item and
		// never touches field lengths.
		const rescuable = admitsMissingClass(normalizedQuery, q.queryWords);

		// Only strict → relaxed is unsound: that cached set already dropped
		// exactly the items the relaxed gate wants back.
		const narrowed =
			cachedSurvivors !== null &&
			normalizedQuery.startsWith(cachedQuery) &&
			(!rescuable || cachedRelaxed);
		const source = narrowed ? cachedSurvivors : null;
		const scanCount = narrowed ? cachedCount : count;

		const survivors = (spare ??= new Int32Array(count));
		let survivorCount = 0;
		const results: FuzzyResult<T>[] = [];
		// A correction scores at least TYPO_PENALTY (2.1), so it can never reach
		// a result set that already holds RESCUE_BUDGET matches at or below
		// SCORES.CONTAINS (2). Past that point the rescue is provably invisible
		// work: it costs 94% of matchField calls to produce ~1% of results
		// (@see docs/benchmarks.md). Counting literal-tier hits rather than all
		// results is what makes it sound — `fuzzy` starts at CONTAINS and rises
		// past 2.1, so fuzzy hits cannot crowd a correction out.
		let literalHits = 0;

		for (let k = 0; k < scanCount; k++) {
			const i = source ? source[k] : k;
			// Tolerate one missing character class, which is what a substitution
			// typo looks like from here (see matchField).
			const missingClasses = queryMask & ~unionMasks[i];
			if (rescuable ? missingClasses & (missingClasses - 1) : missingClasses) continue;
			survivors[survivorCount++] = i;

			const maskBase = i * specCount;
			// Everything past the mask is materialised here, not at build: this
			// item survived, so its text is finally worth paying for. Cached, so a
			// keystroke that revisits the same survivor pays nothing.
			if (LAZY_FIELDS && lazyNorm[maskBase] === undefined) {
				const item = list[i];
				for (let f = 0; f < specCount; f++) {
					const raw = resolvedSpecs[f].text(item) || "";
					const lead = raw.length - raw.trimStart().length;
					if (lead) (leads ??= new Int32Array(count * specCount))[maskBase + f] = lead;
					lazyRaw[maskBase + f] = raw.trim();
					lazyNorm[maskBase + f] = normalizeText(lazyRaw[maskBase + f] as string);
				}
			}
			const prepared = LAZY_FIELDS ? null : preparedFields[i];
			let bestScore = MAX_SAFE_INTEGER;
			let fields: (MatchResult | null)[] | null = null;

			for (let f = 0; f < specCount; f++) {
				const s = resolvedSpecs[f];
				const result = matchField(
					LAZY_FIELDS ? (lazyRaw[maskBase + f] as string) : (prepared as PreparedField[])[f].field,
					LAZY_FIELDS
						? (lazyNorm[maskBase + f] as string)
						: (prepared as PreparedField[])[f].normalizedField,
					fieldMasks[maskBase + f],
					q,
					s.acronym,
					literalHits >= RESCUE_BUDGET,
				);
				if (result) {
					// matchField returns a fresh object per call, so the atBest
					// shift can mutate it instead of spreading a copy.
					result.score += s.atBest;
					if (leads !== null) {
						const lead = leads[maskBase + f];
						if (lead) shiftRanges(result.ranges, lead);
					}
					bestScore = Math.min(bestScore, result.score);
					// oxlint-disable-next-line unicorn/no-new-array
					(fields ??= new Array(specCount).fill(null))[f] = result;
				}
			}

			if (fields) {
				if (bestScore <= SCORES.CONTAINS) literalHits++;
				results.push({ item: list[i], score: bestScore, fields });
			}
		}

		cachedQuery = normalizedQuery;
		cachedRelaxed = rescuable;
		spare = cachedSurvivors; // the retired previous list becomes the next scratch buffer
		cachedSurvivors = survivors;
		cachedCount = survivorCount;

		return results.sort(sortByScore);
	};
}

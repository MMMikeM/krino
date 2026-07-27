/**
 * Public search entry points:
 * - `fuzzyMatch` — the primitive: score one string against a query.
 * - `createFuzzySearch` — a preprocessing-cached, sorted search over a collection,
 *   built on the primitive. Second arg is a `getText` fn or an array of field specs.
 */

import { addRawBigramMask, buildRawGate, buildRescueBigramGate, charMask } from "./gates";
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

// A single character cannot narrow a collection: at 100k items "e" admits
// 85,781 of them, every tier degenerates to `contains`, and the scan allocates
// ~27 MB of results no caller can use. Applies to collection search only —
// `fuzzyMatch` scores one string and has nothing to narrow.
const MIN_QUERY_LENGTH = 2;


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

/**
 * Creates a fuzzy search function for a collection.
 *
 * Queries shorter than two characters return no results — one character matches
 * most of any real collection and ranks none of it.
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
	// Filled on first mask survival, indexed item-major like fieldMasks. Two flat
	// arrays rather than objects: the survivors of one query are a few percent of
	// the corpus, and they recur across keystrokes, so this warms to the working
	// set instead of the whole list.
	// oxlint-disable-next-line unicorn/no-new-array
	const fieldText: (string | undefined)[] = new Array(count * specCount);
	// oxlint-disable-next-line unicorn/no-new-array
	const normalizedText: (string | undefined)[] = new Array(count * specCount);
	// Per-field masks, filled for survivors as their text is materialised, or for
	// everything at once if the rescue ever forces the union scan below.
	const fieldMasks = new Int32Array(count * specCount);
	// Leading-whitespace shifts, allocated only if any field actually has one
	// (real data virtually never does): a slot per item × field would cost
	// ~8 B × count × specs for a value that is almost always 0.
	let leads: Int32Array | null = null;

	// The one structure that has to know something about every item, so the one
	// that costs a pass over the whole list. The literal gate runs against the
	// caller's own strings and needs none of it; only the one-edit rescue does,
	// because it has to admit fields the literal gate rejected. Built the first
	// time a query actually needs that, and never at all for a session whose
	// queries all match literally.
	let unionMasks: Int32Array | null = null;
	// Field-side rescue bigram sets, filled alongside the union masks: only the
	// relaxed rescue scan reads them, and that scan is the only reason the
	// union pass runs at all.
	let bigramLo: Int32Array | null = null;
	let bigramHi: Int32Array | null = null;
	const buildUnionMasks = (): Int32Array => {
		const masks = new Int32Array(count);
		const lo = new Int32Array(count);
		const hi = new Int32Array(count);
		const acc = { lo: 0, hi: 0 };
		for (let i = 0; i < count; i++) {
			const item = list[i];
			let union = 0;
			acc.lo = 0;
			acc.hi = 0;
			for (let f = 0; f < specCount; f++) {
				const text = resolvedSpecs[f].text(item) || "";
				const mask = rawCharMask(text);
				fieldMasks[i * specCount + f] = mask;
				union |= mask;
				addRawBigramMask(text, acc);
			}
			masks[i] = union;
			lo[i] = acc.lo;
			hi[i] = acc.hi;
		}
		unionMasks = masks;
		bigramLo = lo;
		bigramHi = hi;
		return masks;
	};

	// Everything past the filter is materialised here, not at build: this item
	// survived, so its text is finally worth paying for. Cached, so a keystroke
	// that revisits the same survivor pays nothing.
	const materialise = (i: number): void => {
		const base = i * specCount;
		if (normalizedText[base] !== undefined) return;
		const item = list[i];
		for (let f = 0; f < specCount; f++) {
			const raw = resolvedSpecs[f].text(item) || "";
			const lead = raw.length - raw.trimStart().length;
			if (lead) (leads ??= new Int32Array(count * specCount))[base + f] = lead;
			const field = raw.trim();
			fieldText[base + f] = field;
			const normalized = normalizeText(field);
			normalizedText[base + f] = normalized;
			// Already filled, and with strictly more bits, if the union scan ran.
			if (unionMasks === null) fieldMasks[base + f] = charMask(normalized);
		}
	};

	// Prefix-narrowing cache. When the new query extends the previous one (the
	// common case while typing), only the previous survivors need rescanning:
	// every filter here is monotone under query extension, so an item the
	// shorter query rejected stays rejected. Survivors are the filter-pass set,
	// NOT the match set — the match set is not monotone (a field can match
	// "fox brown" via the multi-word tier while failing "fox brow").
	// The two lists are double-buffered: `cachedSurvivors` holds the previous
	// query's set while `spare` receives the current one, then they swap.
	// Reusing the pair keeps the query path allocation-free (a fresh 100k
	// Int32Array costs ~65 µs of alloc + zeroing per keystroke).
	//
	// Monotonicity holds per filter, and the filter is not fixed. Narrowing is
	// sound only when the cached set cannot be missing something this query
	// wants, which takes three things: the query extends the cached one;
	// `cachedMultiWord` matches, because a subsequence-gated set has already
	// dropped fields the out-of-order multi-word tier matches.
	let cachedQuery = "";
	let cachedMultiWord = false;
	let cachedSurvivors: Int32Array | null = null;
	let spare: Int32Array | null = null;
	let cachedCount = 0;

	return (query: string) => {
		const normalizedQuery = normalizeText(query);
		if (normalizedQuery.length < MIN_QUERY_LENGTH) return [];

		const q = prepareQuery(query, normalizedQuery);
		const { queryMask } = q;
		// Same predicate matchField's mask gate uses, so the two cannot drift.
		// It stays a flat query-length test rather than the rescue's
		// field-scaled floor because this scan reads one union mask per item and
		// never touches field lengths.
		const rescuable = admitsMissingClass(normalizedQuery, q.queryWords);
		const multiWord = q.queryWords.length > 1;

		const survivors = (spare ??= new Int32Array(count));
		let survivorCount = 0;
		let results: FuzzyResult<T>[] = [];
		// A correction scores at least TYPO_PENALTY (2.1), so it can never reach
		// a result set that already holds RESCUE_BUDGET matches at or below
		// SCORES.CONTAINS (2). Past that point the rescue is provably invisible
		// work: it costs 94% of matchField calls to produce ~1% of results
		// (@see docs/benchmarks.md). Counting literal-tier hits rather than all
		// results is what makes it sound — `fuzzy` starts at CONTAINS and rises
		// past 2.1, so fuzzy hits cannot crowd a correction out.
		let literalHits = 0;

		const consider = (i: number, noRescue: boolean, gated = false): void => {
			materialise(i);
			const base = i * specCount;
			let bestScore = MAX_SAFE_INTEGER;
			let fields: (MatchResult | null)[] | null = null;

			for (let f = 0; f < specCount; f++) {
				const s = resolvedSpecs[f];
				const result = matchField(
					fieldText[base + f] as string,
					normalizedText[base + f] as string,
					fieldMasks[base + f],
					q,
					s.acronym,
					noRescue || literalHits >= RESCUE_BUDGET,
					gated,
				);
				if (result) {
					// matchField returns a fresh object per call, so the atBest
					// shift can mutate it instead of spreading a copy.
					result.score += s.atBest;
					if (leads !== null) {
						const lead = leads[base + f];
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
		};

		// The cache only ever holds a gate-passing set, so narrowing needs just
		// two things: the query extends the cached one, and the gate is the same
		// kind — a subsequence-gated set has already dropped fields the
		// out-of-order multi-word tier matches.
		const narrowed =
			cachedSurvivors !== null &&
			normalizedQuery.startsWith(cachedQuery) &&
			multiWord === cachedMultiWord;

		// The literal pass: every field the ladder can match outright, and none
		// of the near-misses only a correction reaches. Needs no union masks,
		// which is the point — it runs against the caller's own strings.
		// Returns whether it could run at all.
		const literalPass = (): boolean => {
			if (narrowed) {
				// The gate runs here rather than only inside matchField because its
				// verdict is what shrinks the cached set for the next keystroke.
				// `gated` then stops matchField repeating it on the same string.
				const gate: RegExp | null = multiWord ? q.presenceGate : q.fuzzyGate;
				const cached = cachedSurvivors as Int32Array;
				for (let k = 0; k < cachedCount; k++) {
					const i = cached[k];
					const base = i * specCount;
					let admitted = gate === null;
					for (let f = 0; f < specCount && !admitted; f++) {
						admitted = gate!.test(normalizedText[base + f] as string);
					}
					if (!admitted) continue;
					survivors[survivorCount++] = i;
					consider(i, true, specCount === 1);
				}
				return true;
			}
			if (unionMasks !== null) {
				// A superset of what the gate admits, so caching these survivors
				// keeps the narrowing sound.
				const masks = unionMasks;
				for (let i = 0; i < count; i++) {
					if ((queryMask & ~masks[i]) !== 0) continue;
					survivors[survivorCount++] = i;
					consider(i, true);
				}
				return true;
			}
			// Multi-word queries need the order-independent presence gate, which
			// has no raw-text form yet, so they take the mask path.
			const gate = multiWord ? null : buildRawGate(normalizedQuery);
			if (gate === null) return false;
			for (let i = 0; i < count; i++) {
				const item = list[i];
				let admitted = false;
				for (let f = 0; f < specCount && !admitted; f++) {
					admitted = gate.test(resolvedSpecs[f].text(item) || "");
				}
				if (!admitted) continue;
				survivors[survivorCount++] = i;
				consider(i, true);
			}
			return true;
		};

		const ranLiteral = literalPass();
		// A correction can only matter if fewer than a page of literal hits
		// exist; below that the near-misses have to be looked at, and only the
		// union masks can find them. This is the one thing that forces the
		// whole-corpus pass, and most sessions never reach it.
		let cacheable = ranLiteral;
		if (!ranLiteral || (rescuable && literalHits < RESCUE_BUDGET)) {
			// The relaxed set is not a gate-passing set, so it cannot seed the
			// cache; the next query starts from a full pass instead.
			cacheable = false;
			const masks = unionMasks ?? buildUnionMasks();
			const bLo = bigramLo as Int32Array;
			const bHi = bigramHi as Int32Array;
			const bigramGate = rescuable ? buildRescueBigramGate(normalizedQuery) : null;
			results = [];
			survivorCount = 0;
			literalHits = 0;
			for (let i = 0; i < count; i++) {
				// Tolerate one missing character class, which is what a
				// substitution typo looks like from here (see matchField).
				const missingClasses = queryMask & ~masks[i];
				if (rescuable ? missingClasses & (missingClasses - 1) : missingClasses) continue;
				if (missingClasses !== 0 && bigramGate !== null) {
					// Exactly one class absent, so only an edit at that class's
					// position can rescue — the query's remaining bigrams must all
					// be present (see buildRescueBigramGate).
					const b = 31 - Math.clz32(missingClasses);
					if ((bigramGate.reqLo[b] & ~bLo[i]) | (bigramGate.reqHi[b] & ~bHi[i])) continue;
				}
				survivors[survivorCount++] = i;
				consider(i, false);
			}
		}

		cachedQuery = normalizedQuery;
		cachedMultiWord = multiWord;
		if (cacheable) {
			spare = cachedSurvivors; // the retired previous list becomes the next scratch buffer
			cachedSurvivors = survivors;
			cachedCount = survivorCount;
		} else {
			cachedSurvivors = null;
		}

		return results.sort(sortByScore);
	};
}

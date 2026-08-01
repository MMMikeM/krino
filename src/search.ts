import { buildRawGate, buildRescueBigramGate, charMask } from "./gates";
import { matchField, prepareQuery } from "./match";
import { normaliseText, rawFieldScan } from "./normalise";
import { admitsMissingClass } from "./rescue";
import { SCORES } from "./scores";
import type { FieldSpec, FuzzyResult, FuzzySearcher, MatchOptions, MatchResult } from "./types";

const { MAX_SAFE_INTEGER } = Number;

// Ten because that is the slice a picker shows, and the cutoff the published
// MRR uses; a correction that cannot reach the top ten is work no caller can
// observe through the ranking (@see docs/benchmarks.md).
const RESCUE_BUDGET = 10;

// One character cannot narrow a collection: at 100k items "e" admits 85,781 of
// them and allocates ~27 MB of results no caller can use.
const MIN_QUERY_LENGTH = 2;

const sortByScore = <T>(a: FuzzyResult<T>, b: FuzzyResult<T>): number => a.score - b.score;

// matchField returns fresh Range tuples per call, so mutating in place is safe.
const shiftRanges = (ranges: [number, number][], lead: number): void => {
	for (const range of ranges) {
		range[0] += lead;
		range[1] += lead;
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
	const normalisedQuery = normaliseText(query);
	if (!normalisedQuery.length) return null;

	const q = prepareQuery(query, normalisedQuery);
	const field = text.trim();
	const normalisedField = normaliseText(field);

	const result = matchField(field, normalisedField, charMask(normalisedField), q, acronym);
	const lead = text.length - text.trimStart().length;
	if (result && lead) shiftRanges(result.ranges, lead);
	return result;
};

type ResolvedSpec<T> = { text: (item: T) => string | null; acronym: boolean; atBest: number };

// The whole-corpus rescue index: per-item union masks and bigram sets.
type UnionIndex = { masks: Int32Array; bigramsLo: Int32Array; bigramsHi: Int32Array };

// Resolved once: the per-item loops run count × specs times and shouldn't
// re-default options or capture per-item closures.
const resolveFieldSpecs = <T>(
	extract?: ((item: T) => string | null) | FieldSpec<T>[],
): ResolvedSpec<T>[] => {
	const specs: FieldSpec<T>[] = !extract
		? [{ text: (item) => item as unknown as string }]
		: typeof extract === "function"
			? [{ text: extract }]
			: extract;
	return specs.map((spec) => ({
		text: spec.text,
		acronym: spec.acronym ?? false,
		atBest: spec.atBest ?? 0,
	}));
};

/**
 * Creates a fuzzy search function for a collection.
 *
 * Queries shorter than two characters return no results — one character matches
 * most of any real collection and ranks none of it.
 * An empty spec array is honoured as written: the searcher has no searchable
 * fields and every query returns no results.
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
export function createFuzzySearch<T>(list: T[], specs: FieldSpec<T>[]): FuzzySearcher<T>;
export function createFuzzySearch<T>(
	list: T[],
	extract?: ((item: T) => string | null) | FieldSpec<T>[],
): FuzzySearcher<T> {
	const resolvedSpecs = resolveFieldSpecs(extract);
	const specCount = resolvedSpecs.length;
	const count = list.length;

	// Item-major flat caches, filled per field on first mask survival: survivors
	// are a few percent of the corpus and recur across keystrokes, so this warms
	// to the working set instead of the whole list.
	// oxlint-disable-next-line unicorn/no-new-array
	const trimmedFields: (string | undefined)[] = new Array(count * specCount);
	// oxlint-disable-next-line unicorn/no-new-array
	const normalisedFields: (string | undefined)[] = new Array(count * specCount);
	const fieldMasks = new Int32Array(count * specCount);
	// Allocated only if any field has leading whitespace — real data virtually
	// never does.
	let leads: Int32Array | null = null;

	// The one structure that knows something about every item, so the one that
	// costs a whole-list pass. Only the one-edit rescue needs it — the literal
	// gate runs against the caller's own strings — so it is built the first time
	// a query does, and never for a session whose queries all match literally.
	let unionIndex: UnionIndex | null = null;
	const buildUnionIndex = (): UnionIndex => {
		// With one field per item (every plain string list) the per-field masks ARE
		// the union masks, so the arrays are shared rather than duplicated.
		const masks = specCount === 1 ? fieldMasks : new Int32Array(count);
		const bigramsLo = new Int32Array(count);
		const bigramsHi = new Int32Array(count);
		const bigrams = { lo: 0, hi: 0 };
		for (let i = 0; i < count; i++) {
			const item = list[i];
			let union = 0;
			bigrams.lo = 0;
			bigrams.hi = 0;
			for (let f = 0; f < specCount; f++) {
				const raw = resolvedSpecs[f].text(item) || "";
				const mask = rawFieldScan(raw, bigrams);
				fieldMasks[i * specCount + f] = mask;
				union |= mask;
			}
			masks[i] = union;
			bigramsLo[i] = bigrams.lo;
			bigramsHi[i] = bigrams.hi;
		}
		return { masks, bigramsLo, bigramsHi };
	};

	const materialise = (i: number): void => {
		const base = i * specCount;
		if (normalisedFields[base] !== undefined) return;
		const item = list[i];
		for (let f = 0; f < specCount; f++) {
			const raw = resolvedSpecs[f].text(item) || "";
			const lead = raw.length - raw.trimStart().length;
			if (lead) (leads ??= new Int32Array(count * specCount))[base + f] = lead;
			const field = raw.trim();
			trimmedFields[base + f] = field;
			const normalisedField = normaliseText(field);
			normalisedFields[base + f] = normalisedField;
			// Already filled, with strictly more bits, if the union scan ran.
			if (unionIndex === null) fieldMasks[base + f] = charMask(normalisedField);
		}
	};

	// Prefix-narrowing cache: when the query extends the previous one, only the
	// previous survivors need rescanning. Sound because every filter is monotone
	// under query extension — an item the shorter query rejected stays rejected —
	// and the cached set is always a GATE-passing set of the same gate kind; the
	// match set itself is not monotone (a field can match "fox brown" via the
	// multi-word tier while failing "fox brow"). The two lists double-buffer so
	// the query path stays allocation-free.
	const survivorCache = {
		query: "",
		multiWord: false,
		survivors: null as Int32Array | null,
		spare: null as Int32Array | null,
		count: 0,
	};

	return (query: string) => {
		const normalisedQuery = normaliseText(query);
		if (normalisedQuery.length < MIN_QUERY_LENGTH) return [];

		const prepared = prepareQuery(query, normalisedQuery);
		const { queryMask } = prepared;
		// Same predicate matchField's mask gate uses, so the two cannot drift.
		const relaxable = admitsMissingClass(normalisedQuery, prepared.queryWords);
		const multiWord = prepared.queryWords.length > 1;

		const survivors = (survivorCache.spare ??= new Int32Array(count));
		let survivorCount = 0;
		let results: FuzzyResult<T>[] = [];
		// A correction scores at least TYPO_PENALTY (2.1), so once RESCUE_BUDGET
		// literal hits sit at or below SCORES.CONTAINS (2) no correction can reach
		// the page — the rescue becomes provably invisible work. Fuzzy hits score
		// above 2.1 too, so they cannot crowd a correction out of the count.
		let literalHits = 0;

		const scoreItem = (i: number, mayRescue: boolean, preGated = false): void => {
			materialise(i);
			const base = i * specCount;
			let bestScore = MAX_SAFE_INTEGER;
			let fields: (MatchResult | null)[] | null = null;

			for (let f = 0; f < specCount; f++) {
				const spec = resolvedSpecs[f];
				const result = matchField(
					trimmedFields[base + f] as string,
					normalisedFields[base + f] as string,
					fieldMasks[base + f],
					prepared,
					spec.acronym,
					mayRescue && literalHits < RESCUE_BUDGET,
					preGated,
				);
				if (result) {
					// Fresh object per matchField call, so the atBest shift can mutate.
					result.score += spec.atBest;
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

		const narrowed =
			survivorCache.survivors !== null &&
			normalisedQuery.startsWith(survivorCache.query) &&
			multiWord === survivorCache.multiWord;

		// Every field the ladder can match outright, none of the near-misses only
		// a correction reaches. Needs no union masks — it runs against the
		// caller's own strings. Returns whether it could run at all.
		const literalPass = (): boolean => {
			if (narrowed) {
				// The gate runs out here because its verdict is what shrinks the
				// cached set for the next keystroke; `preGated` stops matchField
				// repeating it on the same string.
				const gate: RegExp | null = multiWord ? prepared.presenceGate : prepared.fuzzyGate;
				const cached = survivorCache.survivors as Int32Array;
				for (let k = 0; k < survivorCache.count; k++) {
					const i = cached[k];
					const base = i * specCount;
					let admitted = gate === null;
					for (let f = 0; f < specCount && !admitted; f++) {
						admitted = gate!.test(normalisedFields[base + f] as string);
					}
					if (!admitted) continue;
					survivors[survivorCount++] = i;
					scoreItem(i, false, specCount === 1);
				}
				return true;
			}
			if (unionIndex !== null) {
				// A superset of what the gate admits, so caching these survivors
				// keeps the narrowing sound.
				const masks = unionIndex.masks;
				for (let i = 0; i < count; i++) {
					if ((queryMask & ~masks[i]) !== 0) continue;
					survivors[survivorCount++] = i;
					scoreItem(i, false);
				}
				return true;
			}
			// The presence gate has no raw-text form yet, so multi-word queries
			// take the mask path.
			const gate = multiWord ? null : buildRawGate(normalisedQuery);
			if (gate === null) return false;
			for (let i = 0; i < count; i++) {
				const item = list[i];
				let admitted = false;
				for (let f = 0; f < specCount && !admitted; f++) {
					admitted = gate.test(resolvedSpecs[f].text(item) || "");
				}
				if (!admitted) continue;
				survivors[survivorCount++] = i;
				scoreItem(i, false);
			}
			return true;
		};

		// Restart from the whole corpus, tolerating one missing character class —
		// what a substitution typo looks like from a mask (see matchField). The
		// only thing that forces the whole-corpus union scan; most sessions never
		// reach it.
		const relaxedPass = (): void => {
			const { masks, bigramsLo, bigramsHi } = (unionIndex ??= buildUnionIndex());
			const bigramGate = relaxable ? buildRescueBigramGate(normalisedQuery) : null;
			results = [];
			survivorCount = 0;
			literalHits = 0;
			for (let i = 0; i < count; i++) {
				const missingClasses = queryMask & ~masks[i];
				if (relaxable ? missingClasses & (missingClasses - 1) : missingClasses) continue;
				if (missingClasses !== 0 && bigramGate !== null) {
					// Exactly one class absent: only an edit at that class's position
					// can rescue, so the query's remaining bigrams must all be present
					// (see buildRescueBigramGate).
					const b = 31 - Math.clz32(missingClasses);
					if (
						(bigramGate.requiredLo[b] & ~bigramsLo[i]) |
						(bigramGate.requiredHi[b] & ~bigramsHi[i])
					) {
						continue;
					}
				}
				survivors[survivorCount++] = i;
				scoreItem(i, true);
			}
		};

		const commitSurvivorCache = (seedNextQuery: boolean): void => {
			survivorCache.query = normalisedQuery;
			survivorCache.multiWord = multiWord;
			if (seedNextQuery) {
				survivorCache.spare = survivorCache.survivors; // the retired list becomes the next scratch buffer
				survivorCache.survivors = survivors;
				survivorCache.count = survivorCount;
			} else {
				survivorCache.survivors = null;
			}
		};

		const ranLiteral = literalPass();
		// A correction can only matter while fewer than a page of literal hits
		// exist; below that the near-misses have to be looked at.
		let cacheable = ranLiteral;
		if (!ranLiteral || (relaxable && literalHits < RESCUE_BUDGET)) {
			// The relaxed set is not a gate-passing set, so it cannot seed the
			// cache; the next query starts from a full pass.
			cacheable = false;
			relaxedPass();
		}
		commitSurvivorCache(cacheable);

		return results.sort(sortByScore);
	};
}

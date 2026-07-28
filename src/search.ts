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

	// Resolved once: the per-item loops run count × specs times and shouldn't
	// re-default options or capture per-item closures.
	const resolvedSpecs = specs.map((s) => ({
		text: s.text,
		acronym: s.acronym ?? false,
		atBest: s.atBest ?? 0,
	}));
	const specCount = resolvedSpecs.length;
	const count = list.length;

	// Item-major flat caches, filled per field on first mask survival: survivors
	// are a few percent of the corpus and recur across keystrokes, so this warms
	// to the working set instead of the whole list.
	// oxlint-disable-next-line unicorn/no-new-array
	const fieldText: (string | undefined)[] = new Array(count * specCount);
	// oxlint-disable-next-line unicorn/no-new-array
	const normalisedText: (string | undefined)[] = new Array(count * specCount);
	const fieldMasks = new Int32Array(count * specCount);
	// Allocated only if any field has leading whitespace — real data virtually
	// never does.
	let leads: Int32Array | null = null;

	// The one structure that knows something about every item, so the one that
	// costs a whole-list pass. Only the one-edit rescue needs it — the literal
	// gate runs against the caller's own strings — so it is built the first time
	// a query does, and never for a session whose queries all match literally.
	let unionMasks: Int32Array | null = null;
	let bigramLo: Int32Array | null = null;
	let bigramHi: Int32Array | null = null;
	const buildUnionMasks = (): Int32Array => {
		// With one field per item (every plain string list) the per-field masks ARE
		// the union masks, so the arrays are shared rather than duplicated.
		const masks = specCount === 1 ? fieldMasks : new Int32Array(count);
		const lo = new Int32Array(count);
		const hi = new Int32Array(count);
		const bigrams = { lo: 0, hi: 0 };
		for (let i = 0; i < count; i++) {
			const item = list[i];
			let union = 0;
			bigrams.lo = 0;
			bigrams.hi = 0;
			for (let f = 0; f < specCount; f++) {
				const text = resolvedSpecs[f].text(item) || "";
				const mask = rawFieldScan(text, bigrams);
				fieldMasks[i * specCount + f] = mask;
				union |= mask;
			}
			masks[i] = union;
			lo[i] = bigrams.lo;
			hi[i] = bigrams.hi;
		}
		unionMasks = masks;
		bigramLo = lo;
		bigramHi = hi;
		return masks;
	};

	const materialise = (i: number): void => {
		const base = i * specCount;
		if (normalisedText[base] !== undefined) return;
		const item = list[i];
		for (let f = 0; f < specCount; f++) {
			const raw = resolvedSpecs[f].text(item) || "";
			const lead = raw.length - raw.trimStart().length;
			if (lead) (leads ??= new Int32Array(count * specCount))[base + f] = lead;
			const field = raw.trim();
			fieldText[base + f] = field;
			const normalised = normaliseText(field);
			normalisedText[base + f] = normalised;
			// Already filled, with strictly more bits, if the union scan ran.
			if (unionMasks === null) fieldMasks[base + f] = charMask(normalised);
		}
	};

	// Prefix-narrowing cache: when the query extends the previous one, only the
	// previous survivors need rescanning. Sound because every filter is monotone
	// under query extension — an item the shorter query rejected stays rejected —
	// and the cached set is always a GATE-passing set of the same gate kind; the
	// match set itself is not monotone (a field can match "fox brown" via the
	// multi-word tier while failing "fox brow"). The two lists double-buffer so
	// the query path stays allocation-free.
	let cachedQuery = "";
	let cachedMultiWord = false;
	let cachedSurvivors: Int32Array | null = null;
	let spare: Int32Array | null = null;
	let cachedCount = 0;

	return (query: string) => {
		const normalisedQuery = normaliseText(query);
		if (normalisedQuery.length < MIN_QUERY_LENGTH) return [];

		const q = prepareQuery(query, normalisedQuery);
		const { queryMask } = q;
		// Same predicate matchField's mask gate uses, so the two cannot drift.
		const rescuable = admitsMissingClass(normalisedQuery, q.queryWords);
		const multiWord = q.queryWords.length > 1;

		const survivors = (spare ??= new Int32Array(count));
		let survivorCount = 0;
		let results: FuzzyResult<T>[] = [];
		// A correction scores at least TYPO_PENALTY (2.1), so once RESCUE_BUDGET
		// literal hits sit at or below SCORES.CONTAINS (2) no correction can reach
		// the page — the rescue becomes provably invisible work. Fuzzy hits score
		// above 2.1 too, so they cannot crowd a correction out of the count.
		let literalHits = 0;

		const consider = (i: number, noRescue: boolean, gated = false): void => {
			materialise(i);
			const base = i * specCount;
			let bestScore = MAX_SAFE_INTEGER;
			let fields: (MatchResult | null)[] | null = null;

			for (let f = 0; f < specCount; f++) {
				const spec = resolvedSpecs[f];
				const result = matchField(
					fieldText[base + f] as string,
					normalisedText[base + f] as string,
					fieldMasks[base + f],
					q,
					spec.acronym,
					noRescue || literalHits >= RESCUE_BUDGET,
					gated,
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
			cachedSurvivors !== null &&
			normalisedQuery.startsWith(cachedQuery) &&
			multiWord === cachedMultiWord;

		// Every field the ladder can match outright, none of the near-misses only
		// a correction reaches. Needs no union masks — it runs against the
		// caller's own strings. Returns whether it could run at all.
		const literalPass = (): boolean => {
			if (narrowed) {
				// The gate runs out here because its verdict is what shrinks the
				// cached set for the next keystroke; `gated` stops matchField
				// repeating it on the same string.
				const gate: RegExp | null = multiWord ? q.presenceGate : q.fuzzyGate;
				const cached = cachedSurvivors as Int32Array;
				for (let k = 0; k < cachedCount; k++) {
					const i = cached[k];
					const base = i * specCount;
					let admitted = gate === null;
					for (let f = 0; f < specCount && !admitted; f++) {
						admitted = gate!.test(normalisedText[base + f] as string);
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
				consider(i, true);
			}
			return true;
		};

		// Restart from the whole corpus, tolerating one missing character class —
		// what a substitution typo looks like from a mask (see matchField). The
		// only thing that forces the whole-corpus union scan; most sessions never
		// reach it.
		const relaxedPass = (): void => {
			const masks = unionMasks ?? buildUnionMasks();
			const pairsLo = bigramLo as Int32Array;
			const pairsHi = bigramHi as Int32Array;
			const bigramGate = rescuable ? buildRescueBigramGate(normalisedQuery) : null;
			results = [];
			survivorCount = 0;
			literalHits = 0;
			for (let i = 0; i < count; i++) {
				const missingClasses = queryMask & ~masks[i];
				if (rescuable ? missingClasses & (missingClasses - 1) : missingClasses) continue;
				if (missingClasses !== 0 && bigramGate !== null) {
					// Exactly one class absent: only an edit at that class's position
					// can rescue, so the query's remaining bigrams must all be present
					// (see buildRescueBigramGate).
					const b = 31 - Math.clz32(missingClasses);
					if ((bigramGate.reqLo[b] & ~pairsLo[i]) | (bigramGate.reqHi[b] & ~pairsHi[i])) continue;
				}
				survivors[survivorCount++] = i;
				consider(i, false);
			}
		};

		const ranLiteral = literalPass();
		// A correction can only matter while fewer than a page of literal hits
		// exist; below that the near-misses have to be looked at.
		let cacheable = ranLiteral;
		if (!ranLiteral || (rescuable && literalHits < RESCUE_BUDGET)) {
			// The relaxed set is not a gate-passing set, so it cannot seed the
			// cache; the next query starts from a full pass.
			cacheable = false;
			relaxedPass();
		}

		cachedQuery = normalisedQuery;
		cachedMultiWord = multiWord;
		if (cacheable) {
			spare = cachedSurvivors; // the retired list becomes the next scratch buffer
			cachedSurvivors = survivors;
			cachedCount = survivorCount;
		} else {
			cachedSurvivors = null;
		}

		return results.sort(sortByScore);
	};
}

/**
 * Every measured library configuration, defined once: compare.bench.ts times
 * them, hits.test.ts ranks them, session.test.ts replays a subset. A
 * configuration defined in only one of those files gets measured on only one
 * axis, which is how a row comes to be timed but never scored.
 *
 * Base rows are library defaults, so a base cell is what `npm install` gives
 * you. Fuse is the exception, on both of its recall knobs, because its defaults
 * are not its strongest configuration — see FUSE_BASE. "(all opts)" rows are
 * the base plus every optional matching feature.
 */
import uFuzzy from "@leeoniya/ufuzzy";
import microfuzzModule from "@nozbe/microfuzz";
import { Searcher } from "fast-fuzzy";
import Fuse, { type IFuseOptions } from "fuse.js";
// Default import, not `{ filter }`: `fuzzy` is CJS whose named exports node's
// ESM loader can't detect, and memory.ts runs this module under plain node.
import fuzzy from "fuzzy";
import fuzzysort from "fuzzysort";
import { matchSorter } from "match-sorter";
import { createFuzzySearch } from "krino";

// The bundlers behind vitest unwrap a CJS `exports.default`; node's ESM loader
// hands back the namespace object instead, and memory.ts runs under plain node.
const cjsDefault = <T>(mod: T): T => (mod as { default?: T }).default ?? mod;
const createMicrofuzz = cjsDefault(microfuzzModule);

export type Probe = {
	count: number;
	/** Ranked items, best first; null when the library returned matches it declined to rank. */
	ranked: string[] | null;
};

export type Config = {
	name: string;
	/** Result count only — the shape compare.bench.ts times. */
	count: (query: string) => number;
	probe: (query: string) => Probe;
	/** Constructor cost alone (plus unavoidable per-searcher preparation like uFuzzy's latinize), or null when the library has no constructor at all. */
	index: (() => number) | null;
	/**
	 * A brand-new searcher with every cache empty and every lazy slice unpaid,
	 * for cold-query timing: the first call on it is the worst case. Omitted for
	 * libraries that keep no per-searcher or process-wide state — their cold and
	 * warm calls are the same call.
	 */
	fresh?: () => (query: string) => number;
	/** Carries cross-query state, so timing loops must bust it between samples. */
	stateful?: boolean;
};

// Two departures from Fuse's defaults, both because the defaults measure worse
// on every axis this suite publishes. `ignoreLocation` off decays the score
// with distance from index 0, a positional handicap rather than a matching one;
// `threshold` at its default 0.6 costs ascii MRR (0.61 -> 0.58), runs 49%
// slower, and returns 6951 of 10000 items for the 5-char `prefix` probe.
export const FUSE_BASE: IFuseOptions<string> = { ignoreLocation: true, threshold: 0.4 };
const FUSE_ALL: IFuseOptions<string> = {
	...FUSE_BASE,
	ignoreDiacritics: true,
	includeMatches: true,
	// Space-separated terms become an AND of fuzzy patterns matched in any
	// order — the same result set krino's multi-word tier returns. Fuse's other
	// multi-word switch, `useTokenSearch`, defaults to OR (`tokenMatch: "any"`)
	// and only reaches these semantics at `tokenMatch: "all"`.
	useExtendedSearch: true,
};

// SingleError with all four edits — uFuzzy's closest config to krino's one-edit rescue.
const UFUZZY_ALL: uFuzzy.Options = {
	intraMode: 1,
	intraIns: 1,
	intraSub: 1,
	intraTrn: 1,
	intraDel: 1,
};

// uFuzzy permutes at most this many terms before giving up on out-of-order
// matching. Below the term count it returns the pre-filtered indices UNRANKED,
// so a value under the longest query's term count silently costs the
// configuration every rank it would have earned.
const OUT_OF_ORDER = 5;

// `pnpm bench --only=krino` narrows a run to the configurations whose name
// contains one of these tokens, so a change to one library can be re-measured
// without re-timing the other thirteen. Comma-separated, case-insensitive
// substrings. Read here rather than passed down because every stage reaches its
// configurations through `configs()`, and a stage that missed the filter would
// silently measure the full matrix.
const ONLY: string[] = (process.env.BENCH_ONLY ?? "")
	.toLowerCase()
	.split(",")
	.map((t) => t.trim())
	.filter(Boolean);

const selected = (name: string): boolean =>
	ONLY.length === 0 || ONLY.some((token) => name.toLowerCase().includes(token));

// Consume a constructed object so creation can't be elided.
const consume = (o: object): number => o.constructor.name.length;

const rankedOnly = (items: string[]): Probe => ({ count: items.length, ranked: items });

const byScore = <T extends { score: number }>(hits: T[]): T[] =>
	[...hits].sort((a, b) => a.score - b.score);

// uFuzzy ranks only below `infoThresh` (default 1000) and hands back bare
// indices above it — no scores, no order, no ranges. Raised here so it does the
// same job as every other row: left at the default, a wide query credits it for
// a filter-only pass while everything else scores, sorts and computes ranges.
// The throw below is the backstop, for the day this stops working.
const RANK_EVERYTHING = 1e9;

const uFuzzyRanked = (
	instance: uFuzzy,
	haystack: string[],
	needle: string,
	outOfOrder = 0,
): [uFuzzy.SearchResult[0], uFuzzy.SearchResult[1], uFuzzy.SearchResult[2]] => {
	const [idxs, info, order] = instance.search(haystack, needle, outOfOrder, RANK_EVERYTHING);
	if (idxs?.length && (!info || !order)) {
		throw new Error(
			`uFuzzy returned ${idxs.length} UNRANKED matches for ${JSON.stringify(needle)}: above infoThresh (1000), so it skipped scoring entirely. Not comparable with a ranked result set.`,
		);
	}
	return [idxs, info, order];
};

// Declining to rank is a legitimate outcome for the quality stage — it scores
// as a miss, which is what it is. Only the speed stage must refuse it, because
// timing a filter-only pass against a ranked one measures nothing.
const uFuzzyProbe =
	(list: string[], instance: uFuzzy, haystack: string[], outOfOrder?: number) =>
	(query: string): Probe => {
		const needle = haystack === list ? query : uFuzzy.latinize([query])[0];
		const [idxs, info, order] = instance.search(haystack, needle, outOfOrder, RANK_EVERYTHING);
		if (!idxs?.length) return { count: 0, ranked: [] };
		if (!info || !order) {
			process.stderr.write(
				`  note: uFuzzy declined to rank ${idxs.length} matches for ${JSON.stringify(needle)} (above infoThresh) — scored as a miss\n`,
			);
			return { count: idxs.length, ranked: null };
		}
		return rankedOnly(order.map((o) => list[info.idx[o]]));
	};

// A configuration builds its searcher inside `make`, so asking for one by name
// constructs one searcher instead of all fourteen — what memory.ts needs to
// attribute a heap delta to a single configuration.
type Definition = { name: string; make: () => Omit<Config, "name"> };

const definitions = (list: string[]): Definition[] => [
	// krino prepares nothing at construction: the char-class masks are built only
	// if a query needs the one-edit rescue, and a field's text only once it
	// survives a filter. The index cell is the constructor alone; everything the
	// construction deferred lands in the COLD query cell, where a fresh searcher
	// pays it — the same split every lazy preparer gets.
	{
		name: "krino",
		make: () => {
			const krino = createFuzzySearch(list);
			return {
				count: (q) => krino(q).length,
				probe: (q) => rankedOnly(krino(q).map((r) => r.item)),
				index: () => consume(createFuzzySearch(list)),
				fresh: () => {
					const s = createFuzzySearch(list);
					return (q) => s(q).length;
				},
				stateful: true,
			};
		},
	},
	{
		name: "krino (acronym)",
		make: () => {
			const spec = [{ text: (x: string) => x, acronym: true }];
			const acronym = createFuzzySearch(list, spec);
			return {
				count: (q) => acronym(q).length,
				probe: (q) => rankedOnly(acronym(q).map((r) => r.item)),
				index: () => consume(createFuzzySearch(list, spec)),
				fresh: () => {
					const s = createFuzzySearch(list, spec);
					return (q) => s(q).length;
				},
				stateful: true,
			};
		},
	},
	{
		name: "@nozbe/microfuzz",
		make: () => {
			const microfuzz = createMicrofuzz(list);
			return {
				count: (q) => microfuzz(q).length,
				probe: (q) => rankedOnly(byScore(microfuzz(q)).map((r) => r.item)),
				index: () => consume(createMicrofuzz(list)),
				fresh: () => {
					const s = createMicrofuzz(list);
					return (q) => s(q).length;
				},
			};
		},
	},
	{
		name: "@nozbe/microfuzz (all opts)",
		make: () => {
			const aggressive = createMicrofuzz(list, { strategy: "aggressive" });
			return {
				count: (q) => aggressive(q).length,
				probe: (q) => rankedOnly(byScore(aggressive(q)).map((r) => r.item)),
				index: () => consume(createMicrofuzz(list, { strategy: "aggressive" })),
				fresh: () => {
					const s = createMicrofuzz(list, { strategy: "aggressive" });
					return (q) => s(q).length;
				},
			};
		},
	},
	{
		name: "fuzzy",
		make: () => ({
			count: (q) => fuzzy.filter(q, list).length,
			probe: (q) => rankedOnly(fuzzy.filter(q, list).map((r) => r.original ?? r.string)),
			index: null,
		}),
	},
	{
		name: "fuzzy (all opts)",
		make: () => ({
			count: (q) => fuzzy.filter(q, list, { pre: "<", post: ">" }).length,
			probe: (q) =>
				rankedOnly(fuzzy.filter(q, list, { pre: "<", post: ">" }).map((r) => r.original ?? r.string)),
			index: null,
		}),
	},
	{
		name: "fuzzysort",
		make: () => ({
			count: (q) => fuzzysort.go(q, list).length,
			probe: (q) => rankedOnly(fuzzysort.go(q, list).map((r) => r.target)),
			// No constructor at all: the prepare-all pass its first go() runs
			// lazily is process-wide state, so it is priced where it is paid —
			// the cold query, via cleanup() emptying the cache.
			index: null,
			fresh: () => {
				fuzzysort.cleanup();
				return (q) => fuzzysort.go(q, list).length;
			},
		}),
	},
	{
		name: "match-sorter",
		make: () => ({
			count: (q) => matchSorter(list, q).length,
			probe: (q) => rankedOnly(matchSorter(list, q)),
			index: null,
		}),
	},
	{
		name: "fast-fuzzy",
		make: () => {
			const fastFuzzy = new Searcher(list);
			return {
				count: (q) => fastFuzzy.search(q).length,
				probe: (q) => rankedOnly(fastFuzzy.search(q)),
				index: () => consume(new Searcher(list)),
				fresh: () => {
					const s = new Searcher(list);
					return (q) => s.search(q).length;
				},
			};
		},
	},
	{
		name: "fast-fuzzy (all opts)",
		make: () => {
			const withMatchData = new Searcher(list, { returnMatchData: true });
			return {
				count: (q) => withMatchData.search(q).length,
				probe: (q) => rankedOnly(withMatchData.search(q).map((m) => m.item)),
				index: () => consume(new Searcher(list, { returnMatchData: true })),
				fresh: () => {
					const s = new Searcher(list, { returnMatchData: true });
					return (q) => s.search(q).length;
				},
			};
		},
	},
	{
		name: "uFuzzy",
		make: () => {
			const uf = new uFuzzy();
			return {
				count: (q) => uFuzzyRanked(uf, list, q)[0]?.length ?? 0,
				probe: uFuzzyProbe(list, uf, list),
				index: null,
			};
		},
	},
	{
		name: "uFuzzy (all opts)",
		make: () => {
			const ufAll = new uFuzzy(UFUZZY_ALL);
			const latinized = uFuzzy.latinize(list);
			return {
				count: (q) =>
					uFuzzyRanked(ufAll, latinized, uFuzzy.latinize([q])[0], OUT_OF_ORDER)[0]?.length ?? 0,
				probe: uFuzzyProbe(list, ufAll, latinized, OUT_OF_ORDER),
				// Latinizing the haystack is real preparation that normally hides as
				// "no index", and this row competes on the total column.
				index: () => uFuzzy.latinize(list).length,
				fresh: () => {
					const uf = new uFuzzy(UFUZZY_ALL);
					const hay = uFuzzy.latinize(list);
					return (q) => uFuzzyRanked(uf, hay, uFuzzy.latinize([q])[0], OUT_OF_ORDER)[0]?.length ?? 0;
				},
			};
		},
	},
	{
		name: "fuse.js",
		make: () => {
			const fuse = new Fuse(list, FUSE_BASE);
			return {
				count: (q) => fuse.search(q).length,
				probe: (q) => rankedOnly(fuse.search(q).map((r) => r.item)),
				index: () => consume(new Fuse(list, FUSE_BASE)),
				fresh: () => {
					const s = new Fuse(list, FUSE_BASE);
					return (q) => s.search(q).length;
				},
			};
		},
	},
	{
		name: "fuse.js (all opts)",
		make: () => {
			const fuseAll = new Fuse(list, FUSE_ALL);
			return {
				count: (q) => fuseAll.search(q).length,
				probe: (q) => rankedOnly(fuseAll.search(q).map((r) => r.item)),
				index: () => consume(new Fuse(list, FUSE_ALL)),
				fresh: () => {
					const s = new Fuse(list, FUSE_ALL);
					return (q) => s.search(q).length;
				},
			};
		},
	},
];

/** Every configuration name, in table order, without constructing anything. */
export const CONFIG_NAMES: string[] = definitions([]).map((d) => d.name);

/**
 * Every configuration against `list`, or just the one named by `only`.
 * Without `only`, BENCH_ONLY narrows the set — an exact request always wins,
 * so the per-cell harnesses keep working during a narrowed pipeline run.
 */
export const configs = (list: string[], only?: string): Config[] =>
	definitions(list)
		.filter((d) => (only == null ? selected(d.name) : d.name === only))
		.map((d) => ({ name: d.name, ...d.make() }));

export const configByName = (all: Config[], name: string): Config => {
	const found = all.find((c) => c.name === name);
	if (!found) throw new Error(`no bench configuration named '${name}'`);
	return found;
};

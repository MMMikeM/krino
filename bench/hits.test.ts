/**
 * Match-count + rank validity: the speed benches time work but never check the
 * work produced results. Every query knows the corpus item it was derived from
 * (corpus.ts `source`), so this runs every benched configuration once per
 * corpus and query and records:
 * - how many items matched (making "fast because it does less" concrete — the
 *   Pass column in docs/benchmarks.md),
 * - where the source item ranked in the library's ordering (`@1` = top hit,
 *   `✗` = matched things but not the item the query came from), and
 * - a per-query time (time-boxed median of the raw search call — magnitude, not
 *   the rigorous vitest-bench numbers).
 */
import { writeFileSync } from "node:fs";
import uFuzzy from "@leeoniya/ufuzzy";
import createMicrofuzz from "@nozbe/microfuzz";
import { Searcher } from "fast-fuzzy";
import Fuse from "fuse.js";
import { filter as fuzzyFilter } from "fuzzy";
import fuzzysort from "fuzzysort";
import { matchSorter } from "match-sorter";
import { describe, expect, it } from "vitest";
import { createFuzzySearch } from "krino";
import { CORPORA } from "./corpus";

const SIZE = 10_000;

type Outcome = { count: number; rank: number | null };
type Runner = (query: string, source: string | null) => Outcome;

const outcome = (ranked: string[], source: string | null): Outcome => ({
	count: ranked.length,
	rank: source == null ? null : ranked.indexOf(source) + 1 || null,
});

const cell = ({ count, rank }: Outcome, source: string | null): string => {
	if (source == null || count === 0) return `${count}`;
	return rank == null ? `${count} ✗` : `${count} @${rank}`;
};

const fmtMs = (ms: number): string => ms.toFixed(2);

// Consumed by every timed call so the JIT can't dead-code-eliminate the work.
let sink = 0;

// Per-corpus scorecards + per-query tables for this process, written to
// scorecard-run.json for the cross-run aggregator (scorecard.mjs) and the
// docs table emitter (tables.mjs).
type ScorecardRow = { library: string; mrr: number; indexMs: number; queryMs: number; totalMs: number };
type QueryTable = {
	kind: string;
	query: string;
	source: string | null;
	cells: Record<string, { count: number; rank: number | null; queryMs: number; totalMs: number }>;
};
const scorecardOut: Record<string, { scorecard: ScorecardRow[]; tables: QueryTable[] }> = {};

// Time-boxed MEDIAN of one call: warm up, then sample for ~100 ms and take the
// middle sample. Median beats a longer mean here — scheduler/GC interruptions
// only ever ADD time, so a mean averages the spikes in while the median rejects
// them; five-second runs would mostly buy more-precisely-averaged noise.
// Each iteration is timed individually so `reset` (untimed) can run between
// samples — krino's prefix-narrowing cache fires on an identical repeated query
// (startsWith is true for equality), so without a bust the loop would time the
// survivor-rescan path while every other library pays a cold query. `reset`
// issues a throwaway query no real query extends, forcing a full cold scan.
const timeQuery = (run: () => number, reset?: () => void): number => {
	for (let i = 0; i < 3; i++) {
		reset?.();
		sink += run();
	}
	const budget = performance.now() + 100;
	const samples: number[] = [];
	while (performance.now() < budget) {
		reset?.();
		const t0 = performance.now();
		sink += run();
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? 0;
};

describe("bench validity: per-library match counts and source rank", () => {
	for (const { name, build, specs } of CORPORA) {
		// The per-cell timing loops (~100 ms × 11 configs × 10 queries) outgrow the
		// default 5 s test timeout.
		it(`[${name}] every library matches the plain-word query`, { timeout: 30_000 }, () => {
			const list = build(SIZE);
			const uf = new uFuzzy();
			const latinized = uFuzzy.latinize(list);
			const krino = createFuzzySearch(list);
			const krinoAcronym = createFuzzySearch(list, [{ text: (x: string) => x, acronym: true }]);
			const microfuzz = createMicrofuzz(list);
			const fastFuzzy = new Searcher(list);
			const fuse = new Fuse(list, { ignoreLocation: true, threshold: 0.4 });
			const fuseAll = new Fuse(list, {
				ignoreLocation: true,
				threshold: 0.4,
				ignoreDiacritics: true,
				includeMatches: true,
				useExtendedSearch: true,
			});

			// uFuzzy's ranked order needs search() info; it's null above the
			// info threshold, where only the count survives.
			const uFuzzyRun = (haystack: string[], needle: string, source: string | null): Outcome => {
				const [idxs, info, order] = uf.search(haystack, needle);
				if (!idxs?.length) return { count: 0, rank: null };
				if (!info || !order) return { count: idxs.length, rank: null };
				const ranked = order.map((o) => list[info.idx[o]]);
				return outcome(ranked, source);
			};

			const runners: Record<string, Runner> = {
				krino: (q, src) => outcome(krino(q).map((r) => r.item), src),
				"krino (acronym)": (q, src) => outcome(krinoAcronym(q).map((r) => r.item), src),
				"@nozbe/microfuzz": (q, src) =>
					outcome(
						microfuzz(q)
							.sort((a, b) => a.score - b.score)
							.map((r) => r.item),
						src,
					),
				fuzzysort: (q, src) => outcome(fuzzysort.go(q, list).map((r) => r.target), src),
				"match-sorter": (q, src) => outcome(matchSorter(list, q), src),
				"fast-fuzzy": (q, src) => outcome(fastFuzzy.search(q), src),
				uFuzzy: (q, src) => uFuzzyRun(list, q, src),
				"uFuzzy (latinize)": (q, src) => uFuzzyRun(latinized, uFuzzy.latinize([q])[0], src),
				"fuse.js": (q, src) => outcome(fuse.search(q).map((r) => r.item), src),
				"fuse.js (all opts)": (q, src) => outcome(fuseAll.search(q).map((r) => r.item), src),
				fuzzy: (q, src) => outcome(fuzzyFilter(q, list).map((r) => r.original ?? r.string), src),
			};

			// Raw search calls only — no rank extraction or sorting overhead —
			// mirroring what the vitest benches time.
			const timers: Record<string, (q: string) => number> = {
				krino: (q) => krino(q).length,
				"krino (acronym)": (q) => krinoAcronym(q).length,
				"@nozbe/microfuzz": (q) => microfuzz(q).length,
				fuzzysort: (q) => fuzzysort.go(q, list).length,
				"match-sorter": (q) => matchSorter(list, q).length,
				"fast-fuzzy": (q) => fastFuzzy.search(q).length,
				uFuzzy: (q) => uf.search(list, q)[0]?.length ?? 0,
				"uFuzzy (latinize)": (q) => uf.search(latinized, uFuzzy.latinize([q])[0])[0]?.length ?? 0,
				"fuse.js": (q) => fuse.search(q).length,
				"fuse.js (all opts)": (q) => fuseAll.search(q).length,
				fuzzy: (q) => fuzzyFilter(q, list).length,
			};

			// Cache busts for searchers with cross-query state: a throwaway query
			// no test query extends, so the next timed call is a full cold scan.
			const CACHE_BUST = "zzzzzz";
			const resets: Record<string, () => void> = {
				krino: () => {
					sink += krino(CACHE_BUST).length;
				},
				"krino (acronym)": () => {
					sink += krinoAcronym(CACHE_BUST).length;
				},
			};

			// One-time index cost per configuration (0 for the libraries that keep
			// no index — their preparation happens inside every query above).
			// Ledger notes: microfuzz defers part of its preparation to the first
			// search (its docs: "the first search takes ~7 ms"), so its cell is
			// time-to-ready: build + first search, with one steady-state search
			// subtracted below (index = build + first − second) so the cell
			// isolates preparation. fuzzysort also preps lazily: its first go()
			// prepares every string target and caches them process-wide (measured
			// ~87× a steady query at 10k), so its cell times an explicit
			// prepare-all loop — the same work go() does lazily, but repeatable,
			// where the one-shot lazy fill would be visible only once per process.
			// uFuzzy (latinize) counts latinizing the haystack — real preparation
			// that normally hides as "no index".
			// Consume a constructed object so creation can't be elided.
			const consume = (o: object): number => o.constructor.name.length;
			const firstQuery = specs[0]?.query ?? "steel";
			const indexers: Record<string, () => number> = {
				krino: () => consume(createFuzzySearch(list)),
				"krino (acronym)": () => consume(createFuzzySearch(list, [{ text: (x: string) => x, acronym: true }])),
				"@nozbe/microfuzz": () => createMicrofuzz(list)(firstQuery).length,
				"fast-fuzzy": () => consume(new Searcher(list)),
				"fuse.js": () => consume(new Fuse(list, { ignoreLocation: true, threshold: 0.4 })),
				"fuse.js (all opts)": () =>
					consume(
						new Fuse(list, {
							ignoreLocation: true,
							threshold: 0.4,
							ignoreDiacritics: true,
							includeMatches: true,
							useExtendedSearch: true,
						}),
					),
				"uFuzzy (latinize)": () => uFuzzy.latinize(list).length,
				fuzzysort: () => {
					let n = 0;
					for (const s of list) n += fuzzysort.prepare(s).target.length;
					return n;
				},
			};
			// Builds are allocation-heavy, so sequential per-config windows pick
			// up order-dependent GC debt: one configuration's garbage is
			// collected inside the next one's timed window (observed as a
			// spurious ~10% index gap between krino's two configs, whose builds
			// are provably identical). Interleave the samples round-robin with a
			// rotating start so GC pauses and process drift land evenly across
			// configurations; median per config as usual.
			const timeInterleaved = (fns: Record<string, () => number>): Record<string, number> => {
				const entries = Object.entries(fns);
				for (const [, fn] of entries) sink += fn();
				const samples = new Map<string, number[]>(entries.map(([k]) => [k, []]));
				const budget = performance.now() + 100 * entries.length;
				let offset = 0;
				while (performance.now() < budget) {
					for (let i = 0; i < entries.length; i++) {
						const [k, fn] = entries[(i + offset) % entries.length];
						const t0 = performance.now();
						sink += fn();
						(samples.get(k) as number[]).push(performance.now() - t0);
					}
					offset++;
				}
				return Object.fromEntries(
					entries.map(([k]) => {
						const xs = (samples.get(k) as number[]).sort((a, b) => a - b);
						return [k, xs[Math.floor(xs.length / 2)] ?? 0];
					}),
				);
			};
			const indexMs: Record<string, number> = timeInterleaved(indexers);
			// The two krino configurations run byte-identical build code (the
			// acronym flag is query-time only; verified interleaved head-to-head
			// — equal mins and medians). Pool their cells so sub-resolution
			// noise (±0.05 ms) can't invent a build-cost difference and flip
			// the pareto frontier between them. The assertion catches any
			// future divergence of the build paths.
			{
				const a = indexMs.krino;
				const b = indexMs["krino (acronym)"];
				expect(Math.abs(a - b) / Math.max(a, b), "krino config builds diverged").toBeLessThan(0.25);
				indexMs.krino = indexMs["krino (acronym)"] = (a + b) / 2;
			}
			// index = build + first − second: subtract one steady-state search of
			// the same query (on the long-lived searcher) so microfuzz's cell is
			// preparation only, not preparation + one query.
			indexMs["@nozbe/microfuzz"] = Math.max(
				0,
				(indexMs["@nozbe/microfuzz"] ?? 0) - timeQuery(() => microfuzz(firstQuery).length),
			);

			// One full warm pass over every lib × query before any timing —
			// early cells otherwise pay the whole process's JIT warmup.
			for (const warm of Object.values(timers)) {
				for (const { query } of specs) sink += warm(query);
			}

			// Per-lib aggregates: reciprocal ranks (miss = 0) over the scored
			// queries, time over every query.
			const scores: Record<string, { rrs: number[]; times: number[] }> = {};

			const tables: QueryTable[] = [];
			const rows = specs.map(({ query, kind, source }) => {
				const row: Record<string, string> = { kind, query };
				const cells: QueryTable["cells"] = {};
				for (const [lib, run] of Object.entries(runners)) {
					const ms = timeQuery(() => timers[lib](query), resets[lib]);
					const { count, rank } = run(query, source);
					const s = (scores[lib] ??= { rrs: [], times: [] });
					s.times.push(ms);
					if (source != null) {
						// MRR@10: a rank outside the top 10 is as invisible to a
						// picker as a miss — both score 0.
						s.rrs.push(rank && rank <= 10 ? 1 / rank : 0);
					}
					// query time against the prebuilt searcher / cold one-shot
					// (query + one-time index) — equal for the no-index libs.
					// total ≈ the FIRST query from cold, but the addend is a
					// steady-state query on purpose: every one-time cost —
					// including microfuzz's lazy first-search slice — is priced
					// into indexMs, so timing a literal first call here would
					// double-count the preparation.
					const total = ms + (indexMs[lib] ?? 0);
					cells[lib] = {
						count,
						rank,
						queryMs: Number(ms.toFixed(3)),
						totalMs: Number(total.toFixed(3)),
					};
					row[lib] = `${cell({ count, rank }, source)} ${fmtMs(ms)}/${fmtMs(total)}ms`;
				}
				tables.push({ kind, query, source, cells });
				return row;
			});
			console.table(rows);

			// Scorecard: MRR with a top-10 cutoff (mean of 1/rank; misses and
			// ranks outside the top 10 score 0) vs mean ms. Result-set size is
			// deliberately not scored — ranked UIs slice to the top N, so a
			// large return costs a picker nothing; the per-query tables above
			// keep the raw counts as the diagnostic (docs/benchmarks.md,
			// "What counts as a match?").
			const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
			const scorecard = Object.entries(scores)
				.map(([library, s]) => {
					const queryMs = Number(mean(s.times).toFixed(3));
					const index = Number((indexMs[library] ?? 0).toFixed(3));
					return {
						library,
						mrr: Number(mean(s.rrs).toFixed(2)),
						indexMs: index,
						queryMs,
						totalMs: Number((index + queryMs).toFixed(3)),
					};
				})
				.sort((a, b) => b.mrr - a.mrr);
			console.table(
				scorecard.map((r) => ({
					library: r.library,
					MRR: r.mrr.toFixed(2),
					"index ms": r.indexMs ? r.indexMs.toFixed(2) : "—",
					"query ms": r.queryMs.toFixed(2),
					"total ms": r.totalMs.toFixed(2),
				})),
			);
			// Machine-readable copy per corpus, consumed by scorecard.mjs (the
			// cross-run aggregator) and tables.mjs (the docs table emitter).
			// Same-process accumulation: the later corpus rewrites the file with
			// both entries.
			scorecardOut[name] = { scorecard, tables };
			writeFileSync(new URL("./scorecard-run.json", import.meta.url), JSON.stringify(scorecardOut, null, "\t"));

			// Every benched lib must find something for a plain corpus word —
			// otherwise its speed numbers time a no-op.
			const plainWord = specs[0];
			for (const [lib, run] of Object.entries(runners)) {
				expect(
					run(plainWord.query, plainWord.source).count,
					`${lib} found nothing for "${plainWord.query}"`,
				).toBeGreaterThan(0);
			}

			for (const { query, kind, source } of specs) {
				const { count, rank } = runners.krino(query, source);
				if (kind === "miss") {
					expect(count, `krino matched garbage "${query}"`).toBe(0);
				} else if (!kind.startsWith("scatter")) {
					// krino must surface the item each query was derived from.
					// (scatter kinds exempt: they probe where smart chunking
					// legitimately gives up — that limit is the measurement.)
					expect(rank, `krino lost source of "${query}" (${kind})`).not.toBeNull();
				}
			}

			// Folding configs must find at least as much as their non-folding
			// base on the accent probe (quantifies the README's †).
			const accentProbe = specs.find((s) => s.kind === "accent-stripped");
			if (accentProbe) {
				const { query, source } = accentProbe;
				expect(runners.krino(query, source).count).toBeGreaterThan(0);
				expect(runners["uFuzzy (latinize)"](query, source).count).toBeGreaterThanOrEqual(
					runners.uFuzzy(query, source).count,
				);
				expect(runners["fuse.js (all opts)"](query, source).count).toBeGreaterThanOrEqual(
					runners["fuse.js"](query, source).count,
				);
			}
		});
	}
});

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
import { describe, expect, it } from "vitest";
import { type ProbeTable, type ScorecardRow, ensureRawDir, rawFile } from "./artifact.ts";
import { type Config, type Probe, configByName, configs } from "./configs.ts";
import { CORPORA } from "./corpus";

const SIZE = 10_000;

type Outcome = { count: number; rank: number | null };

const outcome = ({ count, ranked }: Probe, source: string | null): Outcome => ({
	count,
	rank: source == null || ranked == null ? null : ranked.indexOf(source) + 1 || null,
});

const cell = ({ count, rank }: Outcome, source: string | null): string => {
	if (source == null || count === 0) return `${count}`;
	return rank == null ? `${count} ✗` : `${count} @${rank}`;
};

const fmtMs = (ms: number): string => ms.toFixed(2);

// Consumed by every timed call so the JIT can't dead-code-eliminate the work.
let sink = 0;

// One process's numbers. The pipeline runs several and medians them; RUN names
// the slot so concurrent processes can't overwrite each other.
const RUN = process.env.BENCH_RUN ?? "0";
const runOut: Record<string, { scorecard: ScorecardRow[]; tables: ProbeTable[] }> = {};

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
		// The per-cell timing loops (~100 ms × 14 configs × 15 queries) outgrow the
		// default 5 s test timeout.
		it(`[${name}] every library matches the plain-word query`, { timeout: 60_000 }, () => {
			const list = build(SIZE);
			const all = configs(list);

			// Cache busts for searchers with cross-query state: a throwaway query
			// no test query extends, so the next timed call is a full cold scan.
			const CACHE_BUST = "zzzzzz";
			const resetFor = (config: Config): (() => void) | undefined =>
				config.stateful
					? () => {
							sink += config.count(CACHE_BUST);
						}
					: undefined;

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
			const firstQuery = specs[0]?.query ?? "steel";
			const indexers: Record<string, () => number> = Object.fromEntries(
				all
					.filter((c): c is Config & { index: NonNullable<Config["index"]> } => c.index != null)
					.map((c) => [c.name, () => (c.index as (q: string) => number)(firstQuery)]),
			);
			// Builds are allocation-heavy, so sequential per-config windows pick
			// up order-dependent GC debt: one configuration's garbage is
			// collected inside the next one's timed window (observed as a
			// spurious ~10% index gap between krino's two configs, whose builds
			// are provably identical). Interleave the samples round-robin with a
			// rotating start so GC pauses and process drift land evenly across
			// configurations; median per config as usual.
			const timeInterleaved = (
				fns: Record<string, () => number>,
			): { medians: Record<string, number>; mins: Record<string, number> } => {
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
				const medians: Record<string, number> = {};
				const mins: Record<string, number> = {};
				for (const [k] of entries) {
					const xs = (samples.get(k) as number[]).sort((a, b) => a - b);
					medians[k] = xs[Math.floor(xs.length / 2)] ?? 0;
					mins[k] = xs[0] ?? 0;
				}
				return { medians, mins };
			};
			const { medians: indexMs, mins: indexMin } = timeInterleaved(indexers);
			// The two krino configurations run byte-identical build code (the
			// acronym flag is query-time only; verified interleaved head-to-head
			// — equal mins and medians). Pool their cells so sub-resolution
			// noise (±0.05 ms) can't invent a build-cost difference and flip
			// the pareto frontier between them. The assertion catches any
			// future divergence of the build paths — on the *minimum* sample:
			// noise is one-sided, so the min is the stable noise-free floor,
			// where medians under background load have flaked past 25%.
			{
				const a = indexMin.krino;
				const b = indexMin["krino (acronym)"];
				expect(Math.abs(a - b) / Math.max(a, b), "krino config builds diverged").toBeLessThan(0.25);
				indexMs.krino = indexMs["krino (acronym)"] = (indexMs.krino + indexMs["krino (acronym)"]) / 2;
			}
			// index = build + first − second: subtract one steady-state search of
			// the same query (on the long-lived searcher) so a deferred preparer's
			// cell is preparation only, not preparation + one query.
			for (const config of all.filter((c) => c.deferredIndex)) {
				indexMs[config.name] = Math.max(
					0,
					(indexMs[config.name] ?? 0) - timeQuery(() => config.count(firstQuery)),
				);
			}

			// One full warm pass over every lib × query before any timing —
			// early cells otherwise pay the whole process's JIT warmup.
			for (const config of all) {
				for (const { query } of specs) sink += config.count(query);
			}

			// Per-lib aggregates: reciprocal ranks (miss = 0) over the scored
			// queries, time over every query.
			const scores: Record<string, { rrs: number[]; times: number[] }> = {};

			const tables: ProbeTable[] = [];
			const rows = specs.map(({ query, kind, source }) => {
				const row: Record<string, string> = { kind, query };
				const cells: ProbeTable["cells"] = {};
				for (const config of all) {
					const lib = config.name;
					const ms = timeQuery(() => config.count(query), resetFor(config));
					const { count, rank } = outcome(config.probe(query), source);
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
			// "The corpus and the thirteen probes").
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
			// Same-process accumulation: the later corpus rewrites the file with
			// both entries.
			runOut[name] = { scorecard, tables };
			ensureRawDir();
			writeFileSync(rawFile(`hits-${RUN}.json`), JSON.stringify(runOut, null, "\t"));

			const countFor = (lib: string, query: string, source: string | null): number =>
				outcome(configByName(all, lib).probe(query), source).count;

			// Every benched lib must find something for a plain corpus word —
			// otherwise its speed numbers time a no-op.
			const plainWord = specs[0];
			for (const config of all) {
				expect(
					countFor(config.name, plainWord.query, plainWord.source),
					`${config.name} found nothing for "${plainWord.query}"`,
				).toBeGreaterThan(0);
			}

			const krino = configByName(all, "krino");
			for (const { query, kind, source } of specs) {
				const { count, rank } = outcome(krino.probe(query), source);
				if (kind === "miss") {
					expect(count, `krino matched garbage "${query}"`).toBe(0);
				} else if (!kind.startsWith("scatter")) {
					// krino must surface the item each query was derived from.
					// (Only the scatter kinds are exempt — those probe where chunk
					// assembly legitimately gives up, and that limit is the
					// measurement. The three single-edit typo kinds used to be
					// exempt too, on the grounds that they break the subsequence
					// property outright; the one-edit rescue tiers now recover all
					// of them, so they are held to the same bar as everything else.)
					expect(rank, `krino lost source of "${query}" (${kind})`).not.toBeNull();
				}
			}

			// Folding configs must find at least as much as their non-folding
			// base on the accent probe (quantifies the README's †).
			const accentProbe = specs.find((s) => s.kind === "accent-stripped");
			if (accentProbe) {
				const { query, source } = accentProbe;
				expect(countFor("krino", query, source)).toBeGreaterThan(0);
				for (const lib of ["uFuzzy", "fuse.js"]) {
					expect(
						countFor(`${lib} (all opts)`, query, source),
						`${lib} (all opts) found less than its non-folding base`,
					).toBeGreaterThanOrEqual(countFor(lib, query, source));
				}
			}
		});
	}
});

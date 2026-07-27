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

			// One-time index cost per configuration: the constructor alone (— for
			// libraries with no constructor at all). Every lazy slice — krino's
			// deferred masks, microfuzz's first-search preparation, fuzzysort's
			// process-wide prepare cache — is priced in the COLD query cells
			// below, where a fresh searcher actually pays it; pricing it here too
			// would double-count it in the total column.
			const indexers: Record<string, () => number> = Object.fromEntries(
				all
					.filter((c): c is Config & { index: NonNullable<Config["index"]> } => c.index != null)
					.map((c) => [c.name, c.index as () => number]),
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
				// Construction allocates the survivor buffers and nothing else now
				// that the masks are deferred, so both cells sit at the timer's
				// floor and a *ratio* between them is pure noise. Below that floor
				// the claim worth making is that neither config builds anything.
				const FLOOR_MS = 0.25;
				if (Math.max(a, b) < FLOOR_MS) {
					expect(Math.max(a, b), "krino construction is no longer trivial").toBeLessThan(
						FLOOR_MS,
					);
				} else {
					expect(Math.abs(a - b) / Math.max(a, b), "krino config builds diverged").toBeLessThan(
						0.25,
					);
				}
				indexMs.krino = indexMs["krino (acronym)"] = (indexMs.krino + indexMs["krino (acronym)"]) / 2;
			}
			// One full warm pass over every lib × query before any timing —
			// early cells otherwise pay the whole process's JIT warmup.
			for (const config of all) {
				for (const { query } of specs) sink += config.count(query);
			}

			// Per-lib aggregates: reciprocal ranks (miss = 0) over the scored
			// queries, warm and cold time over every query.
			const scores: Record<string, { rrs: number[]; times: number[]; colds: number[] }> = {};

			// Query cells are NOT interleaved the way the index cells above are.
			// Interleaving makes consecutive samples hit different libraries, so
			// each one runs cache-cold, and at 0.15-0.3 ms per query that warm-up
			// dominates: measured, it inflated fuzzysort 0.18 -> 0.65 ms and uFuzzy
			// 0.18 -> 0.45 while barely touching the slow libraries, which reorders
			// the table rather than just adding noise. A 1-40 ms index build swamps
			// the same effect, which is why it is the right treatment there and the
			// wrong one here. Drift across the phase is instead spread by every
			// configuration being sampled once per query across all fifteen, and
			// detected by the canary below.

			// Drift canary: the same configuration on the same query, before and
			// after the whole timing phase. Interleaving spreads drift evenly
			// across configurations but cannot detect it; this does. A run that
			// moves this far has absorbed load or thermal debt and its cells are
			// not comparable.
			const canaryQuery = specs[0].query;
			const canary = configByName(all, "krino");
			const canaryBefore = timeQuery(() => canary.count(canaryQuery), resetFor(canary));

			const tables: ProbeTable[] = [];
			const rows = specs.map(({ query, kind, source }) => {
				const row: Record<string, string> = { kind, query };
				const cells: ProbeTable["cells"] = {};
				for (const config of all) {
					const lib = config.name;
					const ms = timeQuery(() => config.count(query), resetFor(config));
					const { count, rank } = outcome(config.probe(query), source);
					const s = (scores[lib] ??= { rrs: [], times: [], colds: [] });
					s.times.push(ms);
					if (source != null) {
						// MRR@10: a rank outside the top 10 is as invisible to a
						// picker as a miss — both score 0.
						s.rrs.push(rank && rank <= 10 ? 1 / rank : 0);
					}
					// coldMs and totalMs are filled by the cold phase below, after
					// the drift canary closes the warm timing window.
					cells[lib] = {
						count,
						rank,
						coldMs: 0,
						queryMs: Number(ms.toFixed(3)),
						totalMs: 0,
					};
					row[lib] = `${cell({ count, rank }, source)} ${fmtMs(ms)}ms`;
				}
				tables.push({ kind, query, source, cells });
				return row;
			});
			console.table(rows);

			const canaryAfter = timeQuery(() => canary.count(canaryQuery), resetFor(canary));
			const drift = Math.abs(canaryAfter - canaryBefore) / Math.min(canaryBefore, canaryAfter);
			expect(
				drift,
				`[${name}] machine drifted across the timing phase: krino on "${canaryQuery}" ` +
					`${canaryBefore.toFixed(3)} ms before, ${canaryAfter.toFixed(3)} ms after. ` +
					"Rerun on a quiet machine; these cells are not comparable.",
			).toBeLessThan(0.25);

			// Cold cells: the same query as the FIRST call on a brand-new
			// searcher — every cache empty, every lazy slice unpaid, the worst
			// case a user can hit. Construction stays outside the timed window
			// (the index cell prices it); a configuration without per-searcher
			// state reuses its warm cell, because cold and warm are the same
			// call there. Runs after the drift canary so fresh-searcher builds
			// can't leak GC debt into the warm cells.
			const timeColdQuery = (fresh: () => (q: string) => number, query: string): number => {
				{
					const run = fresh();
					sink += run(query);
				}
				const samples: number[] = [];
				const budget = performance.now() + 100;
				while (performance.now() < budget && samples.length < 25) {
					const run = fresh();
					const t0 = performance.now();
					sink += run(query);
					samples.push(performance.now() - t0);
				}
				samples.sort((a, b) => a - b);
				return samples[samples.length >> 1] ?? 0;
			};
			for (const [i, { query }] of specs.entries()) {
				const t = tables[i];
				for (const config of all) {
					const c = t.cells[config.name];
					c.coldMs = Number(
						(config.fresh ? timeColdQuery(config.fresh, query) : c.queryMs).toFixed(3),
					);
					c.totalMs = Number((c.coldMs + (indexMs[config.name] ?? 0)).toFixed(3));
					scores[config.name].colds.push(c.coldMs);
				}
			}

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
					const coldMs = Number(mean(s.colds).toFixed(3));
					const index = Number((indexMs[library] ?? 0).toFixed(3));
					return {
						library,
						mrr: Number(mean(s.rrs).toFixed(2)),
						indexMs: index,
						coldMs,
						queryMs,
						totalMs: Number((index + coldMs).toFixed(3)),
					};
				})
				.sort((a, b) => b.mrr - a.mrr);
			console.table(
				scorecard.map((r) => ({
					library: r.library,
					MRR: r.mrr.toFixed(2),
					"index ms": r.indexMs ? r.indexMs.toFixed(2) : "—",
					"cold ms": r.coldMs.toFixed(2),
					"warm ms": r.queryMs.toFixed(2),
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
				} else if (kind === "two-words-double-typo") {
					// Two edits in one phrase: the one-edit rescue must refuse
					// rather than guess. The edit-distance engines may match it;
					// krino returning anything here means the multi-word rescue
					// invented a correction.
					expect(count, `krino guessed at the double typo "${query}"`).toBe(0);
				} else if (!kind.startsWith("scatter")) {
					// krino must surface the item each query was derived from.
					// (The scatter kinds are exempt — those probe where chunk
					// assembly legitimately gives up, and that limit is the
					// measurement. The three single-edit typo kinds used to be
					// exempt too, on the grounds that they break the subsequence
					// property outright; the one-edit rescue tiers now recover all
					// of them. The two-words-typo kinds joined them when
					// multiWordRescue landed: the failing word is corrected over
					// the fields the literal words pin down, so a typo inside a
					// phrase is held to the same bar as everything else.)
					expect(rank, `krino lost source of "${query}" (${kind})`).not.toBeNull();
				}
			}

			// Folding configs must find at least as much as their non-folding
			// base on the accent probe (quantifies the README's †).
			const accentProbe = specs.find((s) => s.kind === "accent-stripped");
			if (accentProbe) {
				const { query, source } = accentProbe;
				expect(countFor("krino", query, source)).toBeGreaterThan(0);
				// Cross-library pairs only exist on a full run; `--only=` narrows the
				// set, and a comparison against an absent row would assert nothing.
				const present = new Set(all.map((c) => c.name));
				for (const lib of ["uFuzzy", "fuse.js"]) {
					if (!present.has(lib) || !present.has(`${lib} (all opts)`)) continue;
					expect(
						countFor(`${lib} (all opts)`, query, source),
						`${lib} (all opts) found less than its non-folding base`,
					).toBeGreaterThanOrEqual(countFor(lib, query, source));
				}
			}
		});
	}
});

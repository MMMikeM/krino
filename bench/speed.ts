/**
 * Per-query speed, one library per child process.
 *
 * A shared process shares its pathologies — heap pressure, collections, cache
 * residency, inline-cache shape — between libraries that are supposed to be
 * measured independently, and the previous harness held every corpus×size
 * configuration set live at once (~1.3 GB against a 2.25 GB heap limit). It also
 * makes a cold measurement impossible: by the seventh configuration in a shared
 * process, nothing is cold. @see docs/measurement.md
 *
 * Cells run strictly sequentially. Running them concurrently would reintroduce
 * the contention the isolation exists to remove.
 *
 *   node bench/speed.ts                          # parent: sweep every cell
 *   SPEED_CELL='<corpus>|<size>|<config>' node bench/speed.ts   # one cell
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell } from "./artifact.ts";
import { CONFIG_NAMES, configs } from "./configs.ts";

const CORPORA = ["ascii", "mixed"];
const SIZES = [10_000, 100_000];

// Enough iterations for V8 to reach optimised code: at two (a probe plus one
// warmup, what the old harness did) the samples still time unoptimised code and
// the median reads ~17% high. Bounded by time as well as count, because warmup
// is really about hot-loop iterations: one sweep over 100k items runs the inner
// loop 1.5M times and is plenty, while twenty sweeps of Fuse at 100k would burn
// 54 seconds reaching the same place.
const WARMUP = 20;
const WARMUP_BUDGET_MS = 1000;
// Sampling stops at whichever comes first, so fast cells get the full sample
// count and slow ones (Fuse at 100k is seconds per sample) stop early.
const MAX_SAMPLES = 20;
const MIN_SAMPLES = 5;
const BUDGET_MS = 1000;
// Warm is a median across this many fresh processes, not one median of one
// process's samples. Libraries differ in how much they allocate, so their
// within-process scatter differs: uFuzzy's samples sit inside ±5% while krino's
// span 2.45-5.77 ms at mixed 100k, because it materialises result objects and
// ranges the index-array engines never build. Their per-process MEDIANS agree to
// ±3% either way, so medianing those is what makes the cells comparable.
const WARM_REPS = 5;

type CellResult = {
	build: number;
	cold: number;
	hits: number;
	warm: Cell | null;
};

const corpusPath = (name: string): URL => new URL(`./corpus-${name}.json`, import.meta.url);

const loadCorpus = (name: string, size: number): { list: string[]; queries: string[] } => {
	const list = (JSON.parse(readFileSync(corpusPath(name), "utf8")) as string[]).slice(0, size);
	if (list.length < size) throw new Error(`corpus '${name}' has ${list.length} items, need ${size}`);
	const artifact = JSON.parse(readFileSync(new URL("./results.json", import.meta.url), "utf8")) as {
		probes: Record<string, Array<{ query: string }>>;
	};
	return { list, queries: artifact.probes[name].map((p) => p.query) };
};

const quantile = (sorted: number[], q: number): number =>
	sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

const summarise = (samples: number[], perQuery: number): Cell => {
	const xs = samples.map((s) => s / perQuery).sort((a, b) => a - b);
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1);
	const sd = Math.sqrt(variance);
	return {
		ms: quantile(xs, 0.5),
		mean,
		sd,
		min: xs[0],
		max: xs[xs.length - 1],
		p75: quantile(xs, 0.75),
		p99: quantile(xs, 0.99),
		// 95% confidence half-width as a percentage of the mean, matching how
		// tinybench reported rme so the two are readable against each other.
		rme: mean === 0 ? 0 : (100 * 1.96 * (sd / Math.sqrt(xs.length))) / mean,
		samples: xs.length,
	};
};

const measureCell = (corpus: string, size: number, name: string, warm: boolean): CellResult => {
	const { list, queries } = loadCorpus(corpus, size);
	let sink = 0;

	const builtAt = performance.now();
	const config = configs(list, name)[0];
	const build = performance.now() - builtAt;

	// The first query this process has ever run, on the query every cell uses so
	// the column compares the same work. For the lazy preparers this is where
	// their deferred index actually lands.
	const coldAt = performance.now();
	const hits = config.count(queries[0]);
	const cold = performance.now() - coldAt;

	if (!warm) return { build, cold, hits, warm: null };

	const sweep = (): void => {
		for (const q of queries) sink += config.count(q);
	};
	const warmupDeadline = performance.now() + WARMUP_BUDGET_MS;
	for (let i = 0; i < WARMUP; i++) {
		sweep();
		if (performance.now() > warmupDeadline) break;
	}
	// One collection before sampling rather than one between samples: collecting
	// inside the loop makes every timed window pay the allocation and marking
	// that follows it.
	(globalThis as { gc?: () => void }).gc?.();

	const samples: number[] = [];
	const deadline = performance.now() + BUDGET_MS;
	while (samples.length < MAX_SAMPLES && (samples.length < MIN_SAMPLES || performance.now() < deadline)) {
		const t0 = performance.now();
		sweep();
		samples.push(performance.now() - t0);
	}
	if (sink < 0) throw new Error("unreachable");
	return { build, cold, hits, warm: summarise(samples, queries.length) };
};

const cell = process.env.SPEED_CELL;
if (cell) {
	const [corpus, size, name] = cell.split("|");
	const result = measureCell(corpus, Number(size), name, process.env.SPEED_WARM === "1");
	process.stdout.write(JSON.stringify(result));
} else {
	const self = fileURLToPath(import.meta.url);
	const REPS = Number(process.env.SPEED_REPS ?? 5);
	const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

	// Every map is corpus-keyed, build included: folding diacritics is real work,
	// so a mixed index does not cost what an ascii one does.
	type ByCorpus = Record<string, Record<string, Record<string, number>>>;
	type Sweep = { speed: Record<string, Record<string, Record<string, Cell>>>; build: ByCorpus; cold: ByCorpus };
	const out: Sweep = { speed: {}, build: {}, cold: {} };

	const run = (corpus: string, size: number, name: string, warm: boolean): CellResult =>
		JSON.parse(
			execFileSync(process.execPath, ["--expose-gc", self], {
				env: { ...process.env, SPEED_CELL: `${corpus}|${size}|${name}`, SPEED_WARM: warm ? "1" : "0" },
				encoding: "utf8",
				maxBuffer: 1 << 20,
			}),
		) as CellResult;

	for (const corpus of CORPORA) {
		for (const size of SIZES) {
			for (const [i, name] of CONFIG_NAMES.entries()) {
				const builds: number[] = [];
				const colds: number[] = [];
				const warms: Cell[] = [];
				for (let rep = 0; rep < REPS; rep++) {
					// Warm sampling is the expensive half, so only WARM_REPS of the
					// repetitions carry it; cold is one observation per process and
					// needs all of them. Offset by cell index so the warm passes do
					// not always land at the same point in a sweep.
					const wantWarm = (rep + i) % REPS < WARM_REPS;
					const r = run(corpus, size, name, wantWarm);
					builds.push(r.build);
					colds.push(r.cold);
					if (r.warm) warms.push(r.warm);
					if (r.hits === 0) {
						throw new Error(`[${corpus} ${size}] ${name} returned no hits — timing a no-op`);
					}
				}
				if (!warms.length) throw new Error(`[${corpus} ${size}] ${name}: no warm sample collected`);
				// Median of the per-process medians. min/max/rme span every process,
				// so the cell reports the worst spread any of them saw rather than
				// the spread of whichever one happened to be reported.
				const mids = warms.map((w) => w.ms).sort((a, b) => a - b);
				const warm: Cell = {
					...warms[warms.length >> 1],
					ms: mids[mids.length >> 1],
					min: Math.min(...warms.map((w) => w.min)),
					max: Math.max(...warms.map((w) => w.max)),
					rme: Math.max(...warms.map((w) => w.rme)),
					samples: warms.reduce((a, w) => a + w.samples, 0),
				};
				((out.speed[corpus] ??= {})[name] ??= {})[String(size)] = warm;
				((out.cold[corpus] ??= {})[name] ??= {})[String(size)] = median(colds);
				((out.build[corpus] ??= {})[name] ??= {})[String(size)] = median(builds);
				console.error(
					`[${corpus} ${size / 1000}k] ${name.padEnd(28)} build ${median(builds).toFixed(2).padStart(7)}  cold ${median(colds).toFixed(3).padStart(8)}  warm ${warm.ms.toFixed(3).padStart(7)}  rme ${warm.rme.toFixed(1).padStart(5)}%`,
				);
			}
		}
	}
	writeFileSync(new URL("./.raw/speed.json", import.meta.url), JSON.stringify(out, null, "\t"));
}

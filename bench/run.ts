/**
 * Process-cold bench runner: every sample is a fresh node process, so the JIT,
 * every per-searcher cache, and every process-wide cache (fuzzysort's prepare
 * pool) start empty by construction — no cache busting, no subtraction, no
 * calibration blind spots.
 *
 * A child times two things and nothing else:
 *   index — the constructor call (whatever the configuration's make() does).
 *   query — the first answer to each query, in order. The batch test runs all
 *           twenty probes once each: warmth earned by distinct real queries,
 *           never repetition.
 *
 *   node bench/run.ts <variant|all> <test|all> [count] [--size=10k|100k] [--out=file] [--json]
 *   node bench/run.ts krino mixed/garbage 10
 *   node bench/run.ts all batch 5 --size=10k
 *
 * Variants match by case-insensitive substring; tests by `corpus/kind`, bare
 * `kind` (both corpora), `batch`, or `all`. Count = fresh processes per cell
 * (median published; min and spread kept). Cells are interleaved round-robin
 * across variants with a rotating start so thermal and load drift land evenly,
 * and the run re-times its first cell at the end as a drift canary.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_NAMES, configs } from "./configs.ts";
import { CORPORA } from "./corpus.ts";

type ChildOut = {
	indexMs: number;
	queries: Array<{ query: string; ms: number; count: number }>;
	totalMs: number;
	heapMB: number;
};

// ---------------------------------------------------------------- child mode
const cell = process.env.RUN_CELL;
if (cell) {
	const { corpus, size, variant, queries } = JSON.parse(cell) as {
		corpus: string;
		size: number;
		variant: string;
		queries: string[];
	};
	const corp = CORPORA.find((c) => c.name === corpus);
	if (!corp) throw new Error(`no corpus '${corpus}'`);
	const list = corp.build(size);
	// Parse garbage must not land in the build window; the build keeps its own.
	(globalThis as { gc?: () => void }).gc?.();

	const t0 = performance.now();
	const config = configs(list, variant)[0];
	if (!config) throw new Error(`no variant '${variant}'`);
	const indexMs = performance.now() - t0;

	const out: ChildOut = { indexMs, queries: [], totalMs: 0, heapMB: 0 };
	for (const q of queries) {
		const t = performance.now();
		const count = config.count(q);
		const ms = performance.now() - t;
		out.queries.push({ query: q, ms, count });
		out.totalMs += ms;
	}
	out.heapMB = process.memoryUsage().heapUsed / 2 ** 20;
	process.stdout.write(JSON.stringify(out));
	process.exit(0);
}

// --------------------------------------------------------------- parent mode
const self = fileURLToPath(import.meta.url);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];

type Test = { id: string; corpus: string; queries: string[] };

// The batch opens with the short-word probe as a warmup: a guaranteed literal
// match that absorbs JIT and first-scan costs, so the twenty probes after it
// are the session's steady tail. It is timed (it is the first answer — the
// one-shot column is index + this), published as the batch's `first`.
const tests: Test[] = CORPORA.flatMap((c) => {
	const warmup = c.specs.find((s) => s.kind === "short-word")?.query ?? c.specs[0].query;
	return [
		...c.specs.map((s) => ({ id: `${c.name}/${s.kind}`, corpus: c.name, queries: [s.query] })),
		{ id: `${c.name}/batch`, corpus: c.name, queries: [warmup, ...c.specs.map((s) => s.query)] },
	];
});

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const sizeFlag = flags.find((f) => f.startsWith("--size="))?.slice(7);
const sizes = sizeFlag ? [sizeFlag === "100k" ? 100_000 : 10_000] : [10_000, 100_000];
const outFile = flags.find((f) => f.startsWith("--out="))?.slice(6);
const countFlag = flags.find((f) => f.startsWith("--count="))?.slice(8);
const [variantSel = "all", testSel = "all", countArg] = args;
const count = Number(countFlag ?? countArg ?? "5");
if (!Number.isInteger(count) || count < 1) throw new Error(`bad count '${countArg ?? countFlag}'`);

const variants = CONFIG_NAMES.filter(
	(n) => variantSel === "all" || n.toLowerCase().includes(variantSel.toLowerCase()),
);
if (!variants.length) throw new Error(`no variant matches '${variantSel}'`);
const chosen = tests.filter(
	(t) =>
		testSel === "all" || t.id === testSel || t.id.endsWith(`/${testSel}`) || t.corpus === testSel,
);
if (!chosen.length) throw new Error(`no test matches '${testSel}'`);

const sample = (t: Test, size: number, variant: string): ChildOut =>
	JSON.parse(
		execFileSync(process.execPath, ["--expose-gc", self], {
			env: {
				...process.env,
				RUN_CELL: JSON.stringify({ corpus: t.corpus, size, variant, queries: t.queries }),
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}),
	) as ChildOut;

type CellStats = {
	indexMs: number;
	queryMs: number;
	firstMs: number;
	restMs: number | null;
	/** index + first answer, summed inside each child's consecutive windows. */
	oneShotMs: number;
	minQueryMs: number;
	heapMB: number;
	counts: number[];
	/** Batch cells only: median ms per post-warmup query, in spec order. */
	perQueryMs?: number[];
};

const aggregate = (runs: ChildOut[]): CellStats => {
	const totals = runs.map((r) => r.totalMs);
	const firsts = runs.map((r) => r.queries[0].ms);
	const n = runs[0].queries.length;
	return {
		indexMs: median(runs.map((r) => r.indexMs)),
		queryMs: median(totals),
		firstMs: median(firsts),
		restMs: n > 1 ? median(runs.map((r) => (r.totalMs - r.queries[0].ms) / (n - 1))) : null,
		oneShotMs: median(runs.map((r) => r.indexMs + r.queries[0].ms)),
		minQueryMs: Math.min(...totals),
		heapMB: median(runs.map((r) => r.heapMB)),
		counts: runs[0].queries.map((q) => q.count),
		...(n > 1
			? {
					perQueryMs: runs[0].queries
						.slice(1)
						.map((_, i) => median(runs.map((r) => r.queries[i + 1].ms))),
				}
			: {}),
	};
};

const results = new Map<string, CellStats>();
const key = (t: string, size: number, v: string): string => `${t}@${size / 1000}k ${v}`;

for (const size of sizes) {
	for (const t of chosen) {
		const runs = new Map<string, ChildOut[]>(variants.map((v) => [v, []]));
		for (let rep = 0; rep < count; rep++) {
			// Rotate the variant order per rep so drift lands evenly.
			for (let i = 0; i < variants.length; i++) {
				const v = variants[(i + rep) % variants.length];
				(runs.get(v) as ChildOut[]).push(sample(t, size, v));
				// One dot per finished child, so a long run is visibly alive.
				process.stderr.write(".");
			}
		}
		process.stderr.write("\n");
		for (const v of variants) {
			const cellRuns = runs.get(v) as ChildOut[];
			const stats = aggregate(cellRuns);
			// Result counts must agree across fresh processes — a variant whose
			// answer changes between runs is not timing comparable work.
			for (const r of cellRuns) {
				r.queries.forEach((q, i) => {
					if (q.count !== stats.counts[i]) {
						throw new Error(`${key(t.id, size, v)}: result count drifted (${q.query})`);
					}
				});
			}
			results.set(key(t.id, size, v), stats);
			const one = stats.restMs === null;
			console.error(
				`${key(t.id, size, v).padEnd(46)} index ${stats.indexMs.toFixed(2).padStart(8)}  ` +
					(one
						? `query ${stats.queryMs.toFixed(2).padStart(8)}  (min ${stats.minQueryMs.toFixed(2)})`
						: `batch ${stats.queryMs.toFixed(2).padStart(8)}  first ${stats.firstMs.toFixed(2)}  rest ${(stats.restMs as number).toFixed(3)}`) +
					`  heap ${stats.heapMB.toFixed(0)}MB`,
			);
		}
	}
}

// Physical invariant: the acronym configuration runs strictly more code per
// query, so base krino measuring slower than it means the run absorbed load.
for (const size of sizes) {
	for (const t of chosen) {
		const base = results.get(key(t.id, size, "krino"));
		const acr = results.get(key(t.id, size, "krino (acronym)"));
		if (base && acr && base.queryMs > acr.queryMs * 1.25) {
			console.error(
				`WARNING contaminated: ${t.id}@${size / 1000}k base krino ${base.queryMs.toFixed(2)} > acronym ${acr.queryMs.toFixed(2)}`,
			);
			// More code cannot be faster: refuse to publish a run that violates
			// physics. Only fatal when the run would write an artifact.
			if (outFile) process.exitCode = 1;
		}
	}
}

// Drift canary: the first cell again, after everything.
{
	const t = chosen[0];
	const v = variants[0];
	const size = sizes[0];
	const before = results.get(key(t.id, size, v)) as CellStats;
	const after = aggregate([sample(t, size, v), sample(t, size, v), sample(t, size, v)]);
	const drift = Math.abs(after.queryMs - before.queryMs) / Math.min(after.queryMs, before.queryMs);
	if (drift > 0.25) {
		console.error(
			`WARNING drift: ${key(t.id, size, v)} ${before.queryMs.toFixed(2)} -> ${after.queryMs.toFixed(2)} ms across the run`,
		);
	}
}

// The aggregated matrix, shaped for the artifact:
// corpus → test kind → size → variant → CellStats (sans counts).
const shaped = (): Record<
	string,
	Record<string, Record<string, Record<string, Omit<CellStats, "counts">>>>
> => {
	const out: Record<
		string,
		Record<string, Record<string, Record<string, Omit<CellStats, "counts">>>>
	> = {};
	for (const size of sizes) {
		for (const t of chosen) {
			const kind = t.id.slice(t.corpus.length + 1);
			for (const v of variants) {
				const { counts: _counts, ...stats } = results.get(key(t.id, size, v)) as CellStats;
				(((out[t.corpus] ??= {})[kind] ??= {})[String(size)] ??= {})[v] = stats;
			}
		}
	}
	return out;
};

if (outFile) {
	const { writeFileSync, mkdirSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${JSON.stringify(shaped(), null, "\t")}\n`);
	console.error(`wrote ${outFile}`);
}

// --json: the same matrix on stdout for scripting — cell lines go to stderr,
// so `bench ... --json | jq` sees only the JSON.
if (flags.includes("--json")) {
	process.stdout.write(`${JSON.stringify(shaped(), null, "\t")}\n`);
}

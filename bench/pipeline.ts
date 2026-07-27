import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderPareto } from "../docs/pareto.ts";
import {
	type Artifact,
	type ProbeTable,
	type ScorecardRow,
	contamination,
	ensureRawDir,
	load,
	readRaw,
	reduceBenchRun,
	save,
} from "./artifact.ts";
import { omittedFrom, regions } from "./tables.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const DOC = new URL("../docs/benchmarks.md", import.meta.url);

const flags = new Set(process.argv.slice(2).filter((a) => !a.includes("=")));
const options = new Map(
	process.argv
		.slice(2)
		.filter((a) => a.includes("="))
		.map((a) => a.split("=", 2) as [string, string]),
);

const RUNS = Number(options.get("--runs") ?? 5);
const SCOPE = options.get("--scope") ?? process.env.BENCH ?? "";
const CHECK = flags.has("--check");
const DOCS_ONLY = flags.has("--docs");
// `--only=krino` re-measures one library's cells and merges them over the
// committed artifact, leaving every other row at the value it was published
// with. Unlike --scope this DOES write, because the cells it produces are whole
// — the matrix is complete, one library of it is fresher than the rest.
const ONLY = options.get("--only") ?? "";

// A scoped run measures a partial matrix, so it prints and stops: letting it
// reach the artifact would overwrite published cells with a subset.
const DRY = SCOPE !== "";

// The scope token only selects bench matrix cells, so a scoped run defaults to
// the speed stage alone rather than paying for N hits processes it can't scope.
const measures = !DOCS_ONLY && !CHECK;
const named = flags.has("--speed") || flags.has("--quality");
const stages = {
	speed: measures && (flags.has("--speed") || !named),
	quality: measures && (flags.has("--quality") || (!named && !DRY)),
};

// A scoped run has no artifact to render afterwards, so vitest's own output is
// the result and has to reach the terminal.
const vitest = (args: string, env: Record<string, string> = {}): void => {
	execSync(`pnpm exec vitest ${args}`, {
		cwd: here,
		stdio: ["ignore", DRY ? "inherit" : "ignore", "inherit"],
		env: { ...process.env, ...(ONLY ? { BENCH_ONLY: ONLY } : {}), ...env },
	});
};

// Overlay measured cells onto the committed ones, leaf by leaf, so a narrowed
// run replaces exactly the rows it measured.
const overlay = <T>(into: Record<string, T>, from: Record<string, T>): void => {
	for (const [key, value] of Object.entries(from)) {
		const existing = into[key];
		if (existing && typeof value === "object" && value !== null && !Array.isArray(value)) {
			overlay(existing as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			into[key] = value;
		}
	}
};

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// One corpus×size per process. compare.bench.ts probes every cell at
// registration, so a single process would hold all four corpora and their
// fourteen searchers apiece live at once — the ~1.3 GB that kills a worker.
// @see docs/measurement.md
const SPEED_CELLS = ["ascii-10k", "ascii-100k", "mixed-10k", "mixed-100k"];

const runSpeed = (artifact: Artifact): void => {
	ensureRawDir();
	if (SCOPE) {
		console.error(`speed stage (scoped to ${SCOPE})…`);
		vitest("bench --run", { NODE_OPTIONS: "--expose-gc", BENCH: SCOPE });
		return;
	}
	for (const cell of SPEED_CELLS) {
		console.error(`speed stage: ${cell}…`);
		vitest("bench --run", { NODE_OPTIONS: "--expose-gc", BENCH_CELL: cell });
		const { speed, build } = reduceBenchRun(readRaw("bench.json"));
		// Always overlay, never replace: each process only ever measures its own
		// cell, so a replace would leave the artifact holding one quarter.
		overlay(artifact.speed, speed);
		overlay(artifact.build, build);
	}
};

type HitsRun = Record<string, { scorecard: ScorecardRow[]; tables: ProbeTable[] }>;

const runQuality = (artifact: Artifact): void => {
	ensureRawDir();
	const runs: HitsRun[] = [];
	for (let i = 1; i <= RUNS; i++) {
		console.error(`quality stage: hits run ${i}/${RUNS}…`);
		vitest("run hits.test.ts", { BENCH_RUN: String(i) });
		runs.push(readRaw<HitsRun>(`hits-${i}.json`));
	}
	// Both build a table per library, so a narrowed run would write one holding
	// only the measured rows. Left at their published values instead.
	if (!ONLY) {
		console.error("quality stage: session + long text…");
		vitest("run session.test.ts longtext.test.ts");
	}

	if (DRY) return;

	for (const corpus of Object.keys(runs[0])) {
		const measured = runs[0][corpus].scorecard
			.map(({ library }) => {
				const cells = runs.map((run) => {
					const row = run[corpus].scorecard.find((r) => r.library === library);
					if (!row) throw new Error(`${corpus}/${library}: missing in a run`);
					return row;
				});
				// Ranks are deterministic, so a differing MRR is a bug, not drift.
				const mrrs = new Set(cells.map((c) => c.mrr));
				if (mrrs.size > 1) {
					throw new Error(
						`${corpus}/${library}: MRR differs across runs (${[...mrrs].join(", ")})`,
					);
				}
				const indexMs = median(cells.map((c) => c.indexMs));
				const coldMs = median(cells.map((c) => c.coldMs));
				const queryMs = median(cells.map((c) => c.queryMs));
				return { library, mrr: cells[0].mrr, indexMs, coldMs, queryMs, totalMs: indexMs + coldMs };
			});
		// A narrowed run measures a few rows; the rest keep their published
		// values and the whole board is re-sorted, since a moved row moves rank.
		const kept = ONLY
			? (artifact.scorecard.corpora[corpus] ?? []).filter(
					(row) => !measured.some((m) => m.library === row.library),
				)
			: [];
		artifact.scorecard.corpora[corpus] = [...kept, ...measured].sort(
			(a, b) => b.mrr - a.mrr || a.totalMs - b.totalMs,
		);

		const probes = runs[0][corpus].tables.map((probe, i) => ({
			...probe,
			cells: Object.fromEntries(
				Object.entries(probe.cells).map(([lib, cell]) => [
					lib,
					{
						...cell,
						coldMs: median(runs.map((r) => r[corpus].tables[i].cells[lib].coldMs)),
						queryMs: median(runs.map((r) => r[corpus].tables[i].cells[lib].queryMs)),
						totalMs: median(runs.map((r) => r[corpus].tables[i].cells[lib].totalMs)),
					},
				]),
			),
		}));
		if (ONLY && artifact.probes[corpus]) {
			for (const [i, probe] of probes.entries()) {
				overlay(artifact.probes[corpus][i].cells, probe.cells);
			}
		} else {
			artifact.probes[corpus] = probes;
		}
	}
	if (!ONLY) {
		artifact.scorecard.runs = RUNS;
		artifact.session = readRaw("session.json");
		artifact.longtext = readRaw("longtext.json");
	}
};

const MARKER = /<!-- bench:([a-z0-9-]+) -->\n[\s\S]*?\n<!-- bench:end -->/g;

const inject = (doc: string, tables: Record<string, string>): { doc: string; stale: string[] } => {
	const stale: string[] = [];
	const seen = new Set<string>();
	const next = doc.replace(MARKER, (match, id: string) => {
		const table = tables[id];
		if (table == null) throw new Error(`docs/benchmarks.md marks region '${id}', which nothing generates`);
		seen.add(id);
		const replacement = `<!-- bench:${id} -->\n${table}\n<!-- bench:end -->`;
		if (replacement !== match) stale.push(id);
		return replacement;
	});
	const unmarked = Object.keys(tables).filter((id) => !seen.has(id));
	if (unmarked.length) console.error(`note: generated but not marked in the doc: ${unmarked.join(", ")}`);
	return { doc: next, stale };
};

const artifact = load();

if (ONLY) {
	console.error(
		`--only=${ONLY}: re-measuring matching rows and merging over bench/results.json.\n` +
			"Every other row keeps the value it was published with, so the comparison now\n" +
			"spans two measurement sessions. Fine for iterating on one library; rerun the\n" +
			"full matrix before treating the cross-library ordering as evidence.",
	);
}

if (stages.speed) runSpeed(artifact);
if (stages.quality) runQuality(artifact);

if (DRY) {
	console.error("\nscoped run: artifact and docs left untouched.");
	process.exit(0);
}

// The physical-invariant guard runs before anything is written: a contaminated
// run must not reach the artifact or the docs.
const complaints = contamination(artifact.speed);
for (const c of complaints) console.error(`WARNING: contaminated run — ${c.message}`);
if (complaints.some((c) => c.fatal)) process.exit(1);

const tables = regions(artifact);

if (stages.speed || stages.quality) save(artifact);

const { doc, stale } = inject(readFileSync(DOC, "utf8"), tables);

if (CHECK) {
	if (stale.length) {
		console.error(`stale regions in docs/benchmarks.md: ${stale.join(", ")}`);
		console.error("run `pnpm bench --docs` to bring them up to date.");
		process.exit(1);
	}
	console.error("docs/benchmarks.md agrees with bench/results.json.");
} else {
	writeFileSync(DOC, doc);
	renderPareto(artifact);
	console.error(
		stale.length ? `rewrote ${stale.length} region(s): ${stale.join(", ")}` : "docs already current.",
	);
	for (const corpus of Object.keys(artifact.speed)) {
		const omitted = omittedFrom(artifact, corpus);
		if (omitted.length) console.error(`[${corpus}] omitted (no diacritic folding): ${omitted.join(", ")}`);
	}
}

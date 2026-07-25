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
		env: { ...process.env, ...env },
	});
};

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const runSpeed = (artifact: Artifact): void => {
	console.error(SCOPE ? `speed stage (scoped to ${SCOPE})…` : "speed stage…");
	ensureRawDir();
	vitest("bench --run", { NODE_OPTIONS: "--expose-gc", ...(SCOPE ? { BENCH: SCOPE } : {}) });
	if (DRY) return;
	const { speed, build } = reduceBenchRun(readRaw("bench.json"));
	artifact.speed = speed;
	artifact.build = build;
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
	console.error("quality stage: session + long text…");
	vitest("run session.test.ts longtext.test.ts");

	if (DRY) return;

	for (const corpus of Object.keys(runs[0])) {
		artifact.scorecard.corpora[corpus] = runs[0][corpus].scorecard
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
				const queryMs = median(cells.map((c) => c.queryMs));
				return { library, mrr: cells[0].mrr, indexMs, queryMs, totalMs: indexMs + queryMs };
			})
			.sort((a, b) => b.mrr - a.mrr || a.totalMs - b.totalMs);

		artifact.probes[corpus] = runs[0][corpus].tables.map((probe, i) => ({
			...probe,
			cells: Object.fromEntries(
				Object.entries(probe.cells).map(([lib, cell]) => [
					lib,
					{
						...cell,
						queryMs: median(runs.map((r) => r[corpus].tables[i].cells[lib].queryMs)),
						totalMs: median(runs.map((r) => r[corpus].tables[i].cells[lib].totalMs)),
					},
				]),
			),
		}));
	}
	artifact.scorecard.runs = RUNS;
	artifact.session = readRaw("session.json");
	artifact.longtext = readRaw("longtext.json");
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

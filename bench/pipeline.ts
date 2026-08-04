import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderPareto } from "../docs/pareto.ts";
import {
	type Artifact,
	type ColdMatrix,
	type ProbeTable,
	type ScorecardRow,
	ensureRawDir,
	load,
	rawFile,
	readRaw,
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

// Fresh processes per cold cell. 5 is the dev default; publish runs use 10.
const RUNS = Number(options.get("--runs") ?? 5);
const SCOPE = options.get("--scope") ?? process.env.BENCH ?? "";
const CHECK = flags.has("--check");
const DOCS_ONLY = flags.has("--docs");
// `--only=ekrina` re-measures one library's cells and merges them over the
// committed artifact, leaving every other row at the value it was published
// with. Unlike --scope this DOES write, because the cells it produces are whole
// — the matrix is complete, one library of it is fresher than the rest.
const ONLY = options.get("--only") ?? "";

// A scoped run measures a partial matrix, so it prints and stops: letting it
// reach the artifact would overwrite published cells with a subset.
const DRY = SCOPE !== "";

const measures = !DOCS_ONLY && !CHECK;
const named = flags.has("--speed") || flags.has("--quality");
const stages = {
	cold: measures && (flags.has("--speed") || !named),
	quality: measures && (flags.has("--quality") || (!named && !DRY)),
};

// A scoped run has no artifact to render afterwards, so the runner's own
// output is the result and has to reach the terminal.
const vitest = (args: string, env: Record<string, string> = {}): void => {
	execSync(`pnpm exec vitest ${args}`, {
		cwd: here,
		stdio: ["ignore", DRY ? "inherit" : "ignore", "inherit"],
		env: { ...process.env, ...(ONLY ? { BENCH_ONLY: ONLY } : {}), ...env },
	});
};

// The process-cold runner (bench/run.ts): fresh node process per sample, one
// invocation for the whole matrix — it interleaves cells internally and exits
// nonzero on a contaminated run.
const runner = (variant: string, test: string, extra: string[]): void => {
	execFileSync(process.execPath, [`${here}run.ts`, variant, test, ...extra, `--count=${RUNS}`], {
		cwd: here,
		stdio: ["ignore", "inherit", "inherit"],
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

// An --only run splices cells measured today into a matrix measured earlier,
// which is only honest if the machine is comparable across the two sessions.
// Re-time one library the run does NOT touch and require its committed value
// to reproduce: fail past 25%, warn past 10%.
const anchorCheck = (artifact: Artifact): void => {
	const matches = (variant: string): boolean => variant.toLowerCase().includes(ONLY.toLowerCase());
	const anchor = ["fuzzysort", "uFuzzy", "ekrina"].find((v) => !matches(v));
	if (!anchor) return;
	console.error(`anchor: re-timing ${anchor} short-word@10k against the committed matrix…`);
	const out = execFileSync(
		process.execPath,
		[`${here}run.ts`, anchor, "short-word", "--count=3", "--size=10k", "--json"],
		{ cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	const fresh = JSON.parse(out) as ColdMatrix;
	for (const [corpus, kinds] of Object.entries(fresh)) {
		for (const sizes of Object.values(kinds)) {
			for (const [size, variants] of Object.entries(sizes)) {
				for (const [variant, cell] of Object.entries(variants)) {
					const committed = artifact.coldMatrix[corpus]?.["short-word"]?.[size]?.[variant];
					if (!committed) continue;
					const drift = Math.abs(cell.queryMs - committed.queryMs) / committed.queryMs;
					const line = `${corpus}/short-word@10k ${variant}: ${committed.queryMs.toFixed(2)} -> ${cell.queryMs.toFixed(2)} ms (${(100 * drift).toFixed(0)}%)`;
					if (drift > 0.25) {
						throw new Error(
							`anchor drifted past 25% — this machine is not comparable to the session that measured the matrix; rerun the full matrix instead.\n  ${line}`,
						);
					}
					if (drift > 0.1) console.error(`WARNING anchor drift: ${line}`);
				}
			}
		}
	}
};

// The expected-changed vs expected-stable heuristic: every re-measured cell
// against its committed value, so the operator can confirm the cells that
// moved are the ones the change predicts.
const reportDeltas = (artifact: Artifact, fresh: ColdMatrix): void => {
	const rows: { cell: string; pct: number; line: string }[] = [];
	for (const [corpus, kinds] of Object.entries(fresh)) {
		for (const [kind, sizes] of Object.entries(kinds)) {
			for (const [size, variants] of Object.entries(sizes)) {
				for (const [variant, cell] of Object.entries(variants)) {
					const committed = artifact.coldMatrix[corpus]?.[kind]?.[size]?.[variant];
					if (!committed) continue;
					const pct = (100 * (cell.queryMs - committed.queryMs)) / committed.queryMs;
					rows.push({
						cell: `${corpus}/${kind}@${Number(size) / 1000}k ${variant}`,
						pct,
						line: `${committed.queryMs.toFixed(2)} -> ${cell.queryMs.toFixed(2)} ms  ${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`,
					});
				}
			}
		}
	}
	rows.sort((a, b) => a.pct - b.pct);
	const moved = rows.filter((r) => Math.abs(r.pct) >= 10);
	console.error(
		`\ndelta report: ${rows.length} cells re-measured, ${rows.length - moved.length} within ±10%.`,
	);
	for (const r of moved) console.error(`  ${r.cell.padEnd(46)} ${r.line}`);
	console.error("");
};

const runCold = (artifact: Artifact): void => {
	ensureRawDir();
	if (SCOPE) {
		// Tokens: a corpus, a size, or corpus-size — mapped onto the runner's
		// own filters; prints and stops.
		const token = SCOPE.split(",")[0];
		const [corpus, size] = token.includes("-") ? token.split("-") : [token, ""];
		console.error(`cold stage (scoped to ${token})…`);
		runner("all", corpus || "all", size ? [`--size=${size}`] : []);
		return;
	}
	if (ONLY) anchorCheck(artifact);
	console.error(`cold stage: full matrix, ${RUNS} processes per cell…`);
	const out = fileURLToPath(rawFile("cold-matrix.json"));
	runner(ONLY || "all", "all", [`--out=${out}`]);
	if (ONLY) {
		const fresh = readRaw<ColdMatrix>("cold-matrix.json");
		reportDeltas(artifact, fresh);
		overlay(artifact.coldMatrix, fresh);
	} else {
		artifact.coldMatrix = readRaw<ColdMatrix>("cold-matrix.json");
	}
};

type HitsRun = Record<string, { scorecard: ScorecardRow[]; tables: ProbeTable[] }>;

const runQuality = (artifact: Artifact): void => {
	ensureRawDir();
	console.error("quality stage: ranks + session + long text…");
	vitest("run hits.test.ts");
	// Both build a table per library, so a narrowed run would write one holding
	// only the measured rows. Left at their published values instead.
	if (!ONLY) vitest("run session.test.ts longtext.test.ts");

	if (DRY) return;

	const hits = readRaw<HitsRun>("hits.json");
	for (const corpus of Object.keys(hits)) {
		const { scorecard, tables } = hits[corpus];
		if (ONLY) {
			const kept = (artifact.scorecard.corpora[corpus] ?? []).filter(
				(row) => !scorecard.some((m) => m.library === row.library),
			);
			artifact.scorecard.corpora[corpus] = [...kept, ...scorecard].sort((a, b) => b.mrr - a.mrr);
			for (const [i, probe] of tables.entries()) {
				overlay(artifact.probes[corpus][i].cells, probe.cells);
			}
		} else {
			artifact.scorecard.corpora[corpus] = scorecard;
			artifact.probes[corpus] = tables;
		}
	}
	if (!ONLY) {
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
		if (table == null)
			throw new Error(`docs/benchmarks.md marks region '${id}', which nothing generates`);
		seen.add(id);
		const replacement = `<!-- bench:${id} -->\n${table}\n<!-- bench:end -->`;
		if (replacement !== match) stale.push(id);
		return replacement;
	});
	const unmarked = Object.keys(tables).filter((id) => !seen.has(id));
	if (unmarked.length)
		console.error(`note: generated but not marked in the doc: ${unmarked.join(", ")}`);
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

if (stages.cold) runCold(artifact);
if (stages.quality) runQuality(artifact);

if (DRY) {
	console.error("\nscoped run: artifact and docs left untouched.");
	process.exit(0);
}

const tables = regions(artifact);

if (stages.cold || stages.quality) save(artifact);

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
		stale.length
			? `rewrote ${stale.length} region(s): ${stale.join(", ")}`
			: "docs already current.",
	);
	for (const corpus of Object.keys(artifact.coldMatrix)) {
		const omitted = omittedFrom(artifact, corpus);
		if (omitted.length)
			console.error(`[${corpus}] omitted (no diacritic folding): ${omitted.join(", ")}`);
	}
}

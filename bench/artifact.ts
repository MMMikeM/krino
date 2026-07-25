import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type LibraryMeta, META, baseName } from "./libraries.ts";

export type Cell = { ms: number; sd: number };
export type ScorecardRow = {
	library: string;
	mrr: number;
	indexMs: number;
	queryMs: number;
	totalMs: number;
};
export type ProbeCell = { count: number; rank: number | null; queryMs: number; totalMs: number };
export type ProbeTable = {
	kind: string;
	query: string;
	source: string | null;
	cells: Record<string, ProbeCell>;
};
export type SessionRow = { library: string; stepMs: number[]; sessionMs: number };
export type LongtextRow = {
	docChars: number;
	junkRate: number;
	presentHits: number;
	presentProbes: number;
	missMs: number;
};

export type Artifact = {
	method: Record<string, unknown>;
	libraries: Record<string, LibraryMeta>;
	/** corpus → library → list size → per-query mean/sd. */
	speed: Record<string, Record<string, Record<string, Cell>>>;
	/** library → list size → one-time build ms. */
	build: Record<string, Record<string, number>>;
	scorecard: { runs: number; corpora: Record<string, ScorecardRow[]> };
	probes: Record<string, ProbeTable[]>;
	session: { size: number; corpus: string; steps: string[]; rows: SessionRow[] } | null;
	longtext: { rows: LongtextRow[] } | null;
};

export const ARTIFACT = new URL("./results.json", import.meta.url);
export const RAW_DIR = new URL("./.raw/", import.meta.url);
export const rawFile = (name: string): URL => new URL(name, RAW_DIR);

const METHOD = {
	size: "esbuild --bundle --minify (tree-shaken to primary API) | gzip",
	speed: "vitest bench, per-query mean ± sd; rel = time relative to krino (100%), lower is faster",
	quality:
		"time-boxed median per cell, median across N fresh processes; MRR@10 over the scored probes",
	corpora: {
		ascii: "en faker locale — effectively no diacritics",
		mixed: "mostly en with fr/pl every 7th item — ~5% of items carry a diacritic",
	},
};

const EMPTY: Artifact = {
	method: METHOD,
	libraries: META,
	speed: {},
	build: {},
	scorecard: { runs: 0, corpora: {} },
	probes: {},
	session: null,
	longtext: null,
};

export const load = (): Artifact =>
	existsSync(ARTIFACT) ? (JSON.parse(readFileSync(ARTIFACT, "utf8")) as Artifact) : { ...EMPTY };

export const save = (artifact: Artifact): void => {
	const out: Artifact = { ...artifact, method: METHOD, libraries: META };
	writeFileSync(ARTIFACT, `${JSON.stringify(out, null, "\t")}\n`);
};

export const readRaw = <T>(name: string): T => JSON.parse(readFileSync(rawFile(name), "utf8")) as T;

export const ensureRawDir = (): void => {
	mkdirSync(RAW_DIR, { recursive: true });
};

// A vitest bench group is either "[corpus] query N items × Q queries" (Q queries
// per sample loop, so a sample divides down to one query) or "build index (N
// items)".
const BUILD_NAMES: Record<string, string> = {
	"krino createFuzzySearch": "krino",
	"@nozbe/microfuzz": "@nozbe/microfuzz",
	"fast-fuzzy new Searcher": "fast-fuzzy",
	"fuse.js new Fuse": "fuse.js",
	"fuzzysort prepare (lazy)": "fuzzysort",
};

type VitestBench = { name: string; mean: number; sd: number };
type VitestRaw = { files?: Array<{ groups?: Array<{ fullName?: string; name?: string; benchmarks?: VitestBench[] }> }> };

export const reduceBenchRun = (
	raw: VitestRaw,
): { speed: Artifact["speed"]; build: Artifact["build"] } => {
	const speed: Artifact["speed"] = {};
	const build: Artifact["build"] = {};
	for (const file of raw.files ?? []) {
		for (const group of file.groups ?? []) {
			const label = group.fullName ?? group.name ?? "";
			const query = label.match(/\[(\w+)\] query (\d+) items × (\d+) queries/);
			if (query) {
				const [, corpus, size, perSample] = query;
				for (const b of group.benchmarks ?? []) {
					((speed[corpus] ??= {})[b.name] ??= {})[size] = {
						ms: b.mean / Number(perSample),
						sd: b.sd / Number(perSample),
					};
				}
				continue;
			}
			const built = label.match(/build index \((\d+) items\)/);
			if (!built) continue;
			for (const b of group.benchmarks ?? []) {
				const lib = BUILD_NAMES[b.name];
				if (lib) (build[lib] ??= {})[built[1]] = b.mean;
			}
		}
	}
	return { speed, build };
};

export const indexMsFor = (artifact: Artifact, library: string, size: string): number | null =>
	artifact.build[baseName(library)]?.[size] ?? null;

/**
 * Sizes below this are measured but never published: sub-millisecond cells sit
 * at timer granularity and mostly publish noise.
 */
export const PUBLISHED_SIZE = 100_000;

/**
 * The acronym configuration runs strictly more code per query than base krino,
 * so base measuring slower means the run absorbed GC or thermal debt (2.4×
 * observed on a loaded machine). Only a published size can block the run — at
 * 10k the two configurations differ by less than the timer resolves.
 */
export const contamination = (
	speed: Artifact["speed"],
): Array<{ message: string; fatal: boolean }> => {
	const complaints: Array<{ message: string; fatal: boolean }> = [];
	for (const [corpus, byLib] of Object.entries(speed)) {
		for (const [size, cell] of Object.entries(byLib.krino ?? {})) {
			const acronym = byLib["krino (acronym)"]?.[size]?.ms;
			if (acronym == null || cell.ms <= acronym * 1.15) continue;
			complaints.push({
				fatal: Number(size) >= PUBLISHED_SIZE,
				message:
					`[${corpus}] ${size} items: base krino ${cell.ms.toFixed(2)} ms/query > krino (acronym) ` +
					`${acronym.toFixed(2)} ms/query. More code cannot be faster; rerun on a quiet machine.`,
			});
		}
	}
	return complaints;
};

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type LibraryMeta, META } from "./libraries.ts";

/**
 * One process-cold cell from bench/run.ts: medians across fresh node
 * processes. `queryMs` is the whole test's first-answer total (for the batch
 * test: a short-word warmup match plus all twenty probes once);
 * `firstMs` is the warmup — the process's first answer — and `restMs` the
 * mean of the twenty probes after it; `oneShotMs` is constructor + first answer summed inside
 * each child's consecutive windows. `minQueryMs` is the noise-free floor, kept
 * but never the headline; `heapMB` is the child's heapUsed at exit, a rough
 * memory signal.
 */
export type ColdCell = {
	indexMs: number;
	queryMs: number;
	firstMs: number;
	restMs: number | null;
	oneShotMs: number;
	minQueryMs: number;
	heapMB: number;
	/** Batch cells only: median ms of each post-warmup probe, in spec order. */
	perQueryMs?: number[];
};

/** corpus → test kind (probe kinds + "batch") → list size → variant → cell. */
export type ColdMatrix = Record<string, Record<string, Record<string, Record<string, ColdCell>>>>;

export type ScorecardRow = { library: string; mrr: number };
export type ProbeCell = { count: number; rank: number | null };
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
	coldMatrix: ColdMatrix;
	scorecard: { corpora: Record<string, ScorecardRow[]> };
	probes: Record<string, ProbeTable[]>;
	session: { size: number; corpus: string; steps: string[]; rows: SessionRow[] } | null;
	longtext: { rows: LongtextRow[] } | null;
};

export const ARTIFACT = new URL("./results.json", import.meta.url);
export const RAW_DIR = new URL("./.raw/", import.meta.url);
export const rawFile = (name: string): URL => new URL(name, RAW_DIR);

const METHOD = {
	size: "esbuild --bundle --minify (tree-shaken to primary API) | gzip",
	timing:
		"process-cold (bench/run.ts): every sample is a fresh node process; index = the constructor call, query = the first answer per probe, batch = all probes once in one process; medians across processes, min kept; no warm-loop sampling anywhere",
	quality: "MRR@10 over the scored probes; ranks are deterministic and measured untimed",
	corpora: {
		ascii: "en faker locale — effectively no diacritics",
		mixed: "mostly en with fr/pl every 7th item — ~5% of items carry a diacritic",
	},
};

const EMPTY: Artifact = {
	method: METHOD,
	libraries: META,
	coldMatrix: {},
	scorecard: { corpora: {} },
	probes: {},
	session: null,
	longtext: null,
};

export const load = (): Artifact =>
	existsSync(ARTIFACT)
		? (JSON.parse(readFileSync(ARTIFACT, "utf8")) as Artifact)
		: structuredClone(EMPTY);

export const save = (artifact: Artifact): void => {
	const out: Artifact = { ...artifact, method: METHOD, libraries: META };
	writeFileSync(ARTIFACT, `${JSON.stringify(out, null, "\t")}\n`);
};

export const readRaw = <T>(name: string): T => JSON.parse(readFileSync(rawFile(name), "utf8")) as T;

export const ensureRawDir = (): void => {
	mkdirSync(RAW_DIR, { recursive: true });
};

/**
 * Sizes below this are measured but only the batch rows are published:
 * per-probe cells at every size would drown the doc, and 10k carries the
 * probe-level detail already.
 */
export const PUBLISHED_SIZE = 100_000;

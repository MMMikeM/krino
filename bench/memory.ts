/**
 * Retained index footprint per configuration, one child process per cell.
 *
 * The corpus and the module graph are already resident when the baseline is
 * taken, so the delta is what the searcher itself costs on top of strings the
 * host program was holding anyway — the number a caller actually pays.
 *
 * The metric is `heapUsed + external`, never `heapUsed` alone: typed arrays are
 * accounted in `external` (`arrayBuffers` is a subset of it), and krino's gate
 * is a per-item Int32Array. A heapUsed-only cell would charge krino nothing for
 * its primary structure while charging the object-based engines for every
 * field.
 *
 * Each cell is measured after one warm query, not straight off the constructor:
 * @nozbe/microfuzz defers preparation to its first search and fuzzysort's first
 * go() fills a process-wide cache, so a constructor-only reading would report
 * near-zero for both — the same class of error as the typed-array one.
 *
 *   node --expose-gc bench/memory.ts            # parent: spawns every cell
 *   MEM_CELL='<corpus>|<config>' node --expose-gc bench/memory.ts   # one cell
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_NAMES, type Config, configs } from "./configs.ts";

const SIZE = 100_000;
const RUNS = 3;
const CORPORA = ["ascii", "mixed"];

// corpus.ts imports its snapshots as JSON modules, which needs an import
// attribute plain node won't take, and its derived probe queries are for
// measuring rank. Neither matters here: the warm query exists only to force the
// lazy preparers, so any word actually present in the corpus will do.
const loadCorpus = (name: string): { list: string[]; warmup: string } => {
	const url = new URL(`./corpus-${name}.json`, import.meta.url);
	const list = (JSON.parse(readFileSync(url, "utf8")) as string[]).slice(0, SIZE);
	if (list.length < SIZE) throw new Error(`corpus '${name}' has ${list.length} items`);
	const warmup = (list[0].split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0] ?? "steel").toLowerCase();
	return { list, warmup };
};

export type MemoryCell = {
	heapBytes: number;
	externalBytes: number;
	/** Retained while one searcher is alive: `heapUsed + external`, typed arrays included. */
	totalBytes: number;
	residueBytes: number;
	collected: boolean;
};

// `residueBytes` near `totalBytes` means the library never gives the memory
// back: fuzzysort's `prepare()` cache is process-wide and unevicted, so its cell
// is permanent process cost rather than per-searcher cost. It ships `cleanup()`
// to release it, which nothing here calls.

// A WeakRef keeps its target reachable for the rest of the execution turn that
// observed it, so collections have to be separated by real turn boundaries
// rather than run back to back. Reclaiming a large dead graph also takes
// several passes: four synchronous calls left a dropped 27 MB index still
// counted in heapUsed, which read as a leak that wasn't one.
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const settle = async (): Promise<void> => {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (!gc) throw new Error("bench/memory.ts needs --expose-gc");
	for (let i = 0; i < 8; i++) {
		gc();
		await nextTurn();
	}
};

const sample = (): { heap: number; external: number } => {
	const m = process.memoryUsage();
	return { heap: m.heapUsed, external: m.external };
};

const measureCell = async (corpusName: string, configName: string): Promise<MemoryCell> => {
	const { list, warmup } = loadCorpus(corpusName);

	await settle();
	const before = sample();

	let config: Config | undefined = configs(list, configName)[0];
	config.count(warmup);

	await settle();
	const after = sample();
	// Touch the searcher after the sample so nothing above it can be collected
	// early as unreachable.
	if (config.count(warmup) < 0) throw new Error("unreachable");

	const alive = new WeakRef(config);
	config = undefined;
	await settle();
	const dropped = sample();

	const heapBytes = Math.max(0, after.heap - before.heap);
	const externalBytes = Math.max(0, after.external - before.external);
	return {
		heapBytes,
		externalBytes,
		totalBytes: heapBytes + externalBytes,
		residueBytes: Math.max(0, dropped.heap + dropped.external - before.heap - before.external),
		collected: alive.deref() === undefined,
	};
};

const cell = process.env.MEM_CELL;
if (cell) {
	const [corpusName, configName] = cell.split("|");
	process.stdout.write(JSON.stringify(await measureCell(corpusName, configName)));
} else {
	const self = fileURLToPath(import.meta.url);
	const out: Record<string, Record<string, MemoryCell>> = {};

	for (const corpusName of CORPORA) {
		for (const name of CONFIG_NAMES) {
			const runs: MemoryCell[] = [];
			for (let i = 0; i < RUNS; i++) {
				const raw = execFileSync(process.execPath, ["--expose-gc", self], {
					env: { ...process.env, MEM_CELL: `${corpusName}|${name}` },
					encoding: "utf8",
					maxBuffer: 1 << 20,
				});
				runs.push(JSON.parse(raw) as MemoryCell);
			}
			// Median: a child that caught a stray allocation only ever reads high.
			const mid = (k: "heapBytes" | "externalBytes" | "totalBytes" | "residueBytes"): number =>
				runs.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(RUNS / 2)];
			const measured: MemoryCell = {
				heapBytes: mid("heapBytes"),
				externalBytes: mid("externalBytes"),
				totalBytes: mid("totalBytes"),
				residueBytes: mid("residueBytes"),
				collected: runs.every((r) => r.collected),
			};
			(out[corpusName] ??= {})[name] = measured;
			const mb = (n: number): string => (n / 1024 / 1024).toFixed(2).padStart(8);
			console.error(
				`[${corpusName}] ${name.padEnd(28)} ${mb(measured.totalBytes)} MB` +
					`  heap ${mb(measured.heapBytes)} + ext ${mb(measured.externalBytes)}` +
					`  residue ${mb(measured.residueBytes)}  ${measured.collected ? "" : "NOT COLLECTED"}`,
			);
		}
	}
	writeFileSync(new URL("./.raw/memory.json", import.meta.url), JSON.stringify(out, null, "\t"));
}

/**
 * The workload we actually optimise for: construct, one cold query, two hot
 * ones. Reported as a total, because that is what the caller waits for — a
 * build that pays for itself in four queries never pays for itself here.
 *
 * One library per process, one observation each, median over repetitions: cold
 * happens once per process and cannot be sampled any other way.
 *
 *   node bench/session.ts
 *   SESSION_CELL='<library>|<corpus>|<q1,q2,q3>' node bench/session.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import uFuzzy from "@leeoniya/ufuzzy";
import { createFuzzySearch } from "krino";

const SIZE = 100_000;
const REPS = 7;
// uFuzzy stops ranking above `infoThresh` (default 1000) and hands back bare
// indices — no scores, no order, no ranges. Every query here matches more than
// that, so at the default it would be timed doing filter-only work against a
// library that ranks everything. Raised, and asserted, rather than left to
// silently make the comparison meaningless.
const RANK_EVERYTHING = 1e9;
const LIBRARIES = ["krino", "uFuzzy"];

// Same words in both corpora so the cells compare: `marble` and `cotton` each
// occur ~1,500 times in either. A repeated query is not a wasted cell — it is
// what a caller re-rendering the same term pays, and it isolates the hot path
// from the narrowing the typed sequence gets for free.
const SEQUENCES: [string, string[]][] = [
	["3ch of a 6ch word", ["mar", "mar", "mar"]],
	["the 6ch word", ["marble", "marble", "marble"]],
	["typed 3-4-5", ["cot", "cott", "cotto"]],
];

const load = (corpus: string): string[] =>
	(
		JSON.parse(
			readFileSync(new URL(`./corpus-${corpus}.json`, import.meta.url), "utf8"),
		) as string[]
	).slice(0, SIZE);

type Cell = { build: number; cold: number; hot: number; total: number; hits: number[] };

const cell = process.env.SESSION_CELL;
if (cell) {
	const [library, corpus, joined] = cell.split("|");
	const keys = joined.split(",");
	const list = load(corpus);
	const hits: number[] = [];

	const t0 = performance.now();
	const search =
		library === "uFuzzy"
			? (
					(uf: uFuzzy) =>
					(q: string): number => {
						const [idxs, info, order] = uf.search(list, q, 0, RANK_EVERYTHING);
						if (idxs?.length && (!info || !order)) {
							throw new Error(`uFuzzy declined to rank ${idxs.length} matches for ${q}`);
						}
						return idxs?.length ?? 0;
					}
				)(new uFuzzy())
			: (
					(s: (q: string) => unknown[]) => (q: string) =>
						s(q).length
				)(createFuzzySearch(list));
	const build = performance.now() - t0;

	const t1 = performance.now();
	hits.push(search(keys[0]));
	const cold = performance.now() - t1;

	const t2 = performance.now();
	for (const k of keys.slice(1)) hits.push(search(k));
	const hot = performance.now() - t2;

	process.stdout.write(
		JSON.stringify({ build, cold, hot, total: build + cold + hot, hits } satisfies Cell),
	);
} else {
	const self = fileURLToPath(import.meta.url);
	const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];

	for (const corpus of ["ascii", "mixed"]) {
		for (const [label, keys] of SEQUENCES) {
			process.stderr.write(`\n${corpus} ${SIZE / 1000}k  ${label}: ${keys.join(" -> ")}\n`);
			for (const library of LIBRARIES) {
				const runs: Cell[] = [];
				for (let r = 0; r < REPS; r++) {
					runs.push(
						JSON.parse(
							execFileSync(process.execPath, [self], {
								env: { ...process.env, SESSION_CELL: `${library}|${corpus}|${keys.join(",")}` },
								encoding: "utf8",
							}),
						) as Cell,
					);
				}
				const p = (k: keyof Cell): string =>
					median(runs.map((x) => x[k] as number))
						.toFixed(2)
						.padStart(7);
				process.stderr.write(
					`  ${library.padEnd(8)} build ${p("build")}  cold ${p("cold")}  2 hot ${p("hot")}  TOTAL ${p("total")}   hits ${runs[0].hits.join("/")}\n`,
				);
			}
		}
	}
}

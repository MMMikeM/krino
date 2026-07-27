/**
 * Cold-path decomposition: what a lazy index costs on the query it defers onto.
 *
 * speed.ts measures cold with one probe query, which is the friendly case — a
 * 7-character query whose mask rejects 94% of the corpus. The interesting cases
 * are the selective ones a search box actually starts with: the first keystroke
 * is one character, and one character rejects almost nothing.
 *
 *   node bench/cold.ts                     # sweep
 *   COLD_CELL='<variant>|<corpus>|<query>' node bench/cold.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { variantEntry } from "./variants.ts";

const SIZE = 100_000;
const VARIANTS = ["krino"];
const REPS = 5;

// Prefixes of one probe query, so the sequence is what typing it looks like,
// plus two single characters at opposite ends of the selectivity range.
const QUERIES = ["e", "z", "ge", "gen", "gene", "generic", "generic soft", "generic soft cheese"];

const load = (corpus: string): string[] =>
	(JSON.parse(readFileSync(new URL(`./corpus-${corpus}.json`, import.meta.url), "utf8")) as string[])
		.slice(0, SIZE);

type Result = { build: number; cold: number; second: number; hits: number; seq: number };

const cell = process.env.COLD_CELL;
if (cell) {
	const [variant, corpus, query] = cell.split("|");
	const { createFuzzySearch } = (await import(variant === "krino" ? "krino" : variantEntry(variant))) as {
		createFuzzySearch: (list: string[]) => (q: string) => unknown[];
	};
	const list = load(corpus);

	const t0 = performance.now();
	const search = createFuzzySearch(list);
	const build = performance.now() - t0;

	const t1 = performance.now();
	const hits = search(query).length;
	const cold = performance.now() - t1;

	const t2 = performance.now();
	search(query);
	const second = performance.now() - t2;

	// Same index, but reached one keystroke at a time from empty — the survivor
	// cache narrows each step, and a lazy index pays materialisation on the
	// widest step rather than the last one.
	const fresh = createFuzzySearch(list);
	const t3 = performance.now();
	for (let n = 1; n <= query.length; n++) fresh(query.slice(0, n));
	const seq = performance.now() - t3;

	process.stdout.write(JSON.stringify({ build, cold, second, hits, seq } satisfies Result));
} else {
	const self = fileURLToPath(import.meta.url);
	const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];

	for (const corpus of ["ascii", "mixed"]) {
		console.error(`\n${corpus} ${SIZE / 1000}k`);
		console.error(
			`${"query".padEnd(21)}${"hits".padStart(7)}  ${VARIANTS.map((v) => `${v} build   cold  2nd    typed`).join("   ")}`,
		);
		for (const query of QUERIES) {
			const cells = VARIANTS.map((variant) => {
				const runs: Result[] = [];
				for (let r = 0; r < REPS; r++) {
					runs.push(
						JSON.parse(
							execFileSync(process.execPath, [self], {
								env: { ...process.env, COLD_CELL: `${variant}|${corpus}|${query}` },
								encoding: "utf8",
							}),
						) as Result,
					);
				}
				return {
					build: median(runs.map((r) => r.build)),
					cold: median(runs.map((r) => r.cold)),
					second: median(runs.map((r) => r.second)),
					seq: median(runs.map((r) => r.seq)),
					hits: runs[0].hits,
				};
			});
			const row = cells
				.map((c) => `${c.build.toFixed(1).padStart(8)}${c.cold.toFixed(1).padStart(7)}${c.second.toFixed(2).padStart(7)}${c.seq.toFixed(1).padStart(8)}`)
				.join("  ");
			console.error(`${query.padEnd(21)}${String(cells[0].hits).padStart(7)}  ${row}`);
		}
	}
}

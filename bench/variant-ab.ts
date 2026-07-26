/**
 * Paired A/B across index variants built by variants.ts, reporting build cost
 * and query cost separately — an index change that buys query time by spending
 * more build time is a trade, not a win, and one number hides that.
 *
 * Both measurements interleave the variants with a rotating start, so drift over
 * the run lands on each of them equally rather than on whichever went first.
 * Correctness is a gate, not a column: these are meant to be pure
 * optimisations, so any rank or count change is a bug.
 *
 *   node bench/variant-ab.ts baseline dispatch bigram
 */
import { readFileSync } from "node:fs";
import type { FuzzySearcher } from "../src/types.ts";

const HERE = new URL("./", import.meta.url);
const SIZE = 100_000;
const BUILD_REPS = 9;
const WARM_REPS = 24;
const WARMUP = 15;

type Build = (list: string[]) => FuzzySearcher<string>;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const ms = (v: number): string => v.toFixed(3).padStart(8);
const pct = (v: number, base: number): string =>
	`${v === base ? "" : (v < base ? "-" : "+") + (100 * Math.abs(v / base - 1)).toFixed(1) + "%"}`.padStart(7);

const names = process.argv.slice(2);
if (names.length < 2) throw new Error("give at least two variant names");

const builders: Record<string, Build> = {};
for (const name of names) {
	const mod = (await import(new URL(`./.variants/${name}/index.mjs`, HERE).href)) as {
		createFuzzySearch: Build;
	};
	builders[name] = mod.createFuzzySearch;
}

const artifact = JSON.parse(readFileSync(new URL("./results.json", HERE), "utf8")) as {
	probes: Record<string, Array<{ query: string; kind: string; source: string | null }>>;
};

let sink = 0;

for (const corpus of ["ascii", "mixed"]) {
	const list = (
		JSON.parse(readFileSync(new URL(`./corpus-${corpus}.json`, HERE), "utf8")) as string[]
	).slice(0, SIZE);
	const specs = artifact.probes[corpus];
	const queries = specs.map((p) => p.query);

	const searchers: Record<string, FuzzySearcher<string>> = {};
	for (const name of names) searchers[name] = builders[name](list);

	for (let i = 0; i < WARMUP; i++) {
		for (const name of names) for (const q of queries) sink += searchers[name](q).length;
	}
	const warm: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
	for (let rep = 0; rep < WARM_REPS; rep++) {
		const order = rep % 2 === 0 ? names : [...names].reverse();
		for (const name of order) {
			const t0 = performance.now();
			for (const q of queries) sink += searchers[name](q).length;
			warm[name].push((performance.now() - t0) / queries.length);
		}
	}

	const baseWarm = median(warm[names[0]]);
	console.log(`\n=== ${corpus} @${SIZE / 1000}k`);
	console.log(`${"variant".padEnd(18)}${"query ms".padStart(8)}`);
	for (const name of names) {
		const w = median(warm[name]);
		console.log(`${name.padEnd(18)}${ms(w)}${pct(w, baseWarm)}`);
	}

	// Gate: identical ranks and result counts against the first variant.
	let rankChanges = 0;
	let countChanges = 0;
	const mrr: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
	let scored = 0;
	for (const spec of specs) {
		const items: Record<string, string[]> = {};
		for (const name of names) items[name] = searchers[name](spec.query).map((r) => r.item);
		if (spec.source !== null) {
			scored++;
			for (const name of names) {
				const rank = items[name].indexOf(spec.source) + 1 || null;
				mrr[name] += rank && rank <= 10 ? 1 / rank : 0;
			}
		}
		for (const name of names.slice(1)) {
			if (items[name].length !== items[names[0]].length) countChanges++;
			if (spec.source === null) continue;
			const a = items[names[0]].indexOf(spec.source) + 1 || null;
			const b = items[name].indexOf(spec.source) + 1 || null;
			if (a !== b) {
				rankChanges++;
				console.log(`  RANK CHANGED  ${name}  ${spec.kind}  ${a} -> ${b}`);
			}
		}
	}
	console.log(
		`${"".padEnd(18)}MRR ${names.map((n) => `${n} ${(mrr[n] / scored).toFixed(3)}`).join("  ")}` +
			`  | rank changes ${rankChanges}, count changes ${countChanges}`,
	);

	// Build cost last, and never before the query phase: each rep discards a
	// ~27 MB index, and measuring queries on top of that garbage is the same
	// heap-pressure mistake the old shared-process bench made.
	const builds: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
	for (let rep = 0; rep < BUILD_REPS; rep++) {
		const order = rep % 2 === 0 ? names : [...names].reverse();
		for (const name of order) {
			(globalThis as { gc?: () => void }).gc?.();
			const t0 = performance.now();
			const searcher = builders[name](list);
			builds[name].push(performance.now() - t0);
			sink += searcher(queries[0]).length;
		}
	}
	const baseBuild = median(builds[names[0]]);
	console.log(`${"".padEnd(18)}${"build ms".padStart(8)}`);
	for (const name of names) {
		const b = median(builds[name]);
		console.log(`${name.padEnd(18)}${ms(b)}${pct(b, baseBuild)}`);
	}
}
if (sink < 0) throw new Error("unreachable");

// Emit the docs' per-query match tables (mixed corpus) from the latest
// scorecard-run.json (written by hits.test.ts). Two time columns per row:
// query ms (against the prebuilt searcher) and total ms (query + the
// configuration's one-time index cost — the honest cold one-shot number;
// the two are equal for libraries that keep no index).
//   pnpm --filter=krino-bench exec vitest run hits.test.ts && node bench/tables.mjs
import { readFileSync } from "node:fs";

const run = JSON.parse(readFileSync(new URL("./scorecard-run.json", import.meta.url), "utf8"));

// Doc row order + display labels (subset shown in docs/benchmarks.md;
// match-sorter and fuzzy track the microfuzz row and are omitted there).
const LABELS = [
	["krino", "Krino"],
	["krino (acronym)", "Krino (acronym)"],
	["@nozbe/microfuzz", "@nozbe/microfuzz"],
	["fast-fuzzy", "fast-fuzzy"],
	["fuse.js", "Fuse.js"],
	["fuzzysort", "fuzzysort"],
	["uFuzzy", "uFuzzy"],
];

for (const t of run.mixed.tables) {
	if (t.source == null) continue; // the guaranteed-miss query gets no table
	console.log(`\n#### ${t.kind}: \`${t.query}\`\n`);
	console.log("| Library            | rank | matches | query ms | total ms |");
	console.log("|--------------------|-----:|--------:|---------:|---------:|");
	for (const [key, label] of LABELS) {
		const c = t.cells[key];
		const rank = c.count === 0 ? "—" : (c.rank ?? "✗");
		console.log(
			`| ${label.padEnd(18)} | ${String(rank).padStart(4)} | ${String(c.count).padStart(7)} | ${c.queryMs.toFixed(2).padStart(8)} | ${c.totalMs.toFixed(2).padStart(8)} |`,
		);
	}
}

// Cross-run scorecard aggregator: N fresh vitest processes, median per cell.
// Two-level noise defence: within a run, timeQuery medians hundreds of
// individually-timed calls (intra-run noise — GC, scheduler spikes); this layer
// handles process-level drift (JIT tier-up, CPU frequency/thermals, background
// load), which samples inside one process all share and cannot cancel.
// Median across runs ≈ the trim-the-extremes-and-average instinct, one fewer knob.
//   node bench/scorecard.mjs [runs=5]
// Prints a markdown table per corpus (MRR | index | query | total, medians).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUNS = Number(process.argv[2] ?? 5);
const here = fileURLToPath(new URL(".", import.meta.url));

const runs = [];
for (let i = 1; i <= RUNS; i++) {
	console.error(`scorecard run ${i}/${RUNS}…`);
	execSync("pnpm exec vitest run hits.test.ts", { cwd: here, stdio: ["ignore", "ignore", "inherit"] });
	runs.push(JSON.parse(readFileSync(new URL("./scorecard-run.json", import.meta.url), "utf8")));
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

for (const corpus of Object.keys(runs[0])) {
	console.log(`\n### Scorecard — ${corpus} corpus (median of ${RUNS} runs)\n`);
	console.log("| Library            |  MRR | index ms | query ms | total ms |");
	console.log("|--------------------|-----:|---------:|---------:|---------:|");
	const rows = runs[0][corpus].scorecard.map(({ library }) => {
		const cells = runs.map((run) => {
			const row = run[corpus].scorecard.find((r) => r.library === library);
			if (!row) throw new Error(`${corpus}/${library}: missing in a run`);
			return row;
		});
		const mrrs = new Set(cells.map((c) => c.mrr));
		if (mrrs.size > 1) throw new Error(`${corpus}/${library}: MRR differs across runs (${[...mrrs].join(", ")}) — ranks should be deterministic`);
		const index = median(cells.map((c) => c.indexMs));
		const med = median(cells.map((c) => c.queryMs));
		return { library, mrr: cells[0].mrr, index, med, total: index + med };
	});
	rows.sort((a, b) => b.mrr - a.mrr || a.total - b.total);
	for (const r of rows) {
		const idx = r.index ? r.index.toFixed(2) : "—";
		console.log(
			`| ${r.library.padEnd(18)} | ${r.mrr.toFixed(2)} | ${idx.padStart(8)} | ${r.med.toFixed(2).padStart(8)} | ${r.total.toFixed(2).padStart(8)} |`,
		);
	}
}

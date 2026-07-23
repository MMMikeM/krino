/**
 * Frontend session probe: three keystrokes on the 100k mixed corpus starting at
 * the 3-char UI gate, each extending the last (typing). krino's prefix-narrowing cache rescans only
 * the previous query's mask-gate survivors, so successive keystrokes get
 * cheaper; every other library pays a full scan per keystroke.
 * Each step is timed at its correct cache state: `reset` (untimed) replays the
 * PREVIOUS prefix before every sample, so step k measures exactly "the user has
 * typed k-1 and presses the next key". Step 1 resets with a cache bust.
 * Prints the markdown table for docs/benchmarks.md ("A frontend session").
 *   pnpm --filter=krino-bench exec vitest run session --disable-console-intercept
 */
import uFuzzy from "@leeoniya/ufuzzy";
import createMicrofuzz from "@nozbe/microfuzz";
import Fuse from "fuse.js";
import fuzzysort from "fuzzysort";
import { expect, it } from "vitest";
import { createFuzzySearch } from "krino";
import { CORPORA } from "./corpus";

const SIZE = 100_000;
const CACHE_BUST = "zzzzzz";

let sink = 0;

// Same time-boxed median as hits.test.ts (see there for the rationale).
const timeQuery = (run: () => number, reset?: () => void): number => {
	for (let i = 0; i < 3; i++) {
		reset?.();
		sink += run();
	}
	const budget = performance.now() + 100;
	const samples: number[] = [];
	while (performance.now() < budget) {
		reset?.();
		const t0 = performance.now();
		sink += run();
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? 0;
};

it("frontend session: three successive queries at 100k", { timeout: 60_000 }, () => {
	const mixed = CORPORA.find((c) => c.name === "mixed");
	if (!mixed) throw new Error("mixed corpus missing");
	const list = mixed.build(SIZE);
	// The surname probe ("grady", the doc's word-2 query), typed keystroke by
	// keystroke from the 3-char UI gate: "gra" -> "grad" -> "grady" — the last
	// step is the complete word.
	const word = mixed.specs[1].query;
	const steps = [3, 4, 5].map((k) => word.slice(0, k));

	const krino = createFuzzySearch(list);
	const microfuzz = createMicrofuzz(list);
	const uf = new uFuzzy();
	const latinized = uFuzzy.latinize(list);
	const fuseAll = new Fuse(list, {
		ignoreLocation: true,
		threshold: 0.4,
		ignoreDiacritics: true,
		includeMatches: true,
		useExtendedSearch: true,
	});

	// stateful: true wires the typing-cache state (reset replays the previous
	// prefix); stateless libraries just run cold every sample.
	const libs: Array<{ name: string; run: (q: string) => number; stateful?: boolean }> = [
		{ name: "krino (smart)", run: (q) => krino(q).length, stateful: true },
		{ name: "@nozbe/microfuzz", run: (q) => microfuzz(q).length },
		{ name: "fuzzysort", run: (q) => fuzzysort.go(q, list).length },
		{ name: "uFuzzy (latinize)", run: (q) => uf.search(latinized, uFuzzy.latinize([q])[0])[0]?.length ?? 0 },
		{ name: "fuse.js (all opts)", run: (q) => fuseAll.search(q).length },
	];

	console.log(`\nsteps: ${steps.map((s) => `\`${s}\``).join(" -> ")} (${SIZE} items, mixed corpus)\n`);
	console.log("| Library            | " + steps.map((s) => `\`${s}\``.padStart(8)).join(" | ") + " |  session |");
	console.log("|--------------------|" + steps.map(() => "---------:").join("|") + "|---------:|");
	for (const { name, run, stateful } of libs) {
		const stepMs = steps.map((q, k) => {
			const reset = stateful
				? () => {
						sink += run(k === 0 ? CACHE_BUST : (steps[k - 1] as string));
					}
				: undefined;
			return timeQuery(() => run(q), reset);
		});
		const session = stepMs.reduce((a, b) => a + b, 0);
		expect(session).toBeGreaterThan(0);
		console.log(
			`| ${name.padEnd(18)} | ${stepMs.map((m) => m.toFixed(2).padStart(8)).join(" | ")} | ${session.toFixed(2).padStart(8)} |`,
		);
	}
	expect(sink).toBeGreaterThan(0);
});

/**
 * Frontend session probe: three keystrokes on the 100k mixed corpus starting at
 * the 3-char UI gate, each extending the last (typing). krino's prefix-narrowing cache rescans only
 * the previous query's mask-gate survivors, so successive keystrokes get
 * cheaper; every other library pays a full scan per keystroke.
 * Each step is timed at its correct cache state: `reset` (untimed) replays the
 * PREVIOUS prefix before every sample, so step k measures exactly "the user has
 * typed k-1 and presses the next key". Step 1 resets with a cache bust.
 */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { type SessionRow, ensureRawDir, rawFile } from "./artifact.ts";
import { configByName, configs } from "./configs.ts";
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
	// The surname probe ("grady", the doc's short-word query), typed keystroke by
	// keystroke from the 3-char UI gate: "gra" -> "grad" -> "grady" — the last
	// step is the complete word.
	const word = mixed.specs[1].query;
	const steps = [3, 4, 5].map((k) => word.slice(0, k));

	// A configuration's `stateful` flag wires the typing-cache state (reset
	// replays the previous prefix); stateless libraries just run cold every
	// sample.
	const all = configs(list);
	const libs = ["krino", "@nozbe/microfuzz", "fuzzysort", "uFuzzy (all opts)", "fuse.js (all opts)"]
		.map((lib) => configByName(all, lib));

	const rows: SessionRow[] = [];
	for (const { name, count: run, stateful } of libs) {
		const stepMs = steps.map((q, k) => {
			const reset = stateful
				? () => {
						sink += run(k === 0 ? CACHE_BUST : (steps[k - 1] as string));
					}
				: undefined;
			return timeQuery(() => run(q), reset);
		});
		const sessionMs = stepMs.reduce((a, b) => a + b, 0);
		expect(sessionMs).toBeGreaterThan(0);
		rows.push({ library: name, stepMs, sessionMs });
	}
	expect(sink).toBeGreaterThan(0);

	ensureRawDir();
	writeFileSync(
		rawFile("session.json"),
		JSON.stringify({ size: SIZE, corpus: "mixed", steps, rows }, null, "\t"),
	);
});

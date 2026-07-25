import { defineConfig } from "vitest/config";

// A BENCH=-scoped dev run measures a partial matrix, so it writes no JSON and
// the pipeline has nothing to reduce into the published artifact.
export default defineConfig({
	test: {
		benchmark: process.env.BENCH ? {} : { outputJson: ".raw/bench.json" },
	},
});

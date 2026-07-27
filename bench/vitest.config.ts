import { defineConfig } from "vitest/config";

// A BENCH=-scoped dev run measures a partial matrix, so it writes no JSON and
// the pipeline has nothing to reduce into the published artifact.
export default defineConfig({
	test: {
		benchmark: process.env.BENCH ? {} : { outputJson: ".raw/bench.json" },
		// Every file here holds two 100k corpora plus their indexes; eight forks
		// of that is enough to take one of them out with an unexplained worker
		// exit. The suite is memory-bound, not CPU-bound, so parallelism buys
		// nothing anyway.
		fileParallelism: false,
	},
});

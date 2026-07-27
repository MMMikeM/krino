import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Every file here holds two 100k corpora plus their indexes; eight forks
		// of that is enough to take one of them out with an unexplained worker
		// exit. The suite is memory-bound, not CPU-bound, so parallelism buys
		// nothing anyway.
		fileParallelism: false,
	},
});

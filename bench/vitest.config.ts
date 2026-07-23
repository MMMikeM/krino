import { defineConfig } from "vitest/config";

// Benchmarks write machine-readable results to results.json alongside the table
// — but only for FULL runs: a BENCH=-scoped dev run would overwrite the publish
// artifact with a partial matrix, so scoped runs skip the JSON.
export default defineConfig({
	test: {
		benchmark: process.env.BENCH ? {} : { outputJson: "results.json" },
	},
});

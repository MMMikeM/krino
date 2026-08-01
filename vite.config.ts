import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		useTabs: true,
		// The bench pipeline owns results.json, the frozen corpora, and every
		// marked region in docs/benchmarks.md — formatting them fights the
		// generator and `pnpm bench --check`.
		ignorePatterns: ["dist", "bench/results.json", "bench/corpus-*.json", "docs/benchmarks.md"],
	},
	lint: {
		plugins: ["typescript", "unicorn", "oxc"],
		categories: { correctness: "error" },
		rules: {},
		env: { builtin: true },
		ignorePatterns: [],
	},
	pack: {
		entry: ["./src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		clean: true,
		sourcemap: false,
		minify: true,
		publint: true,
		attw: true,
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});

/**
 * Cross-library comparison. Fair-task caveats:
 * - Fuse.js and fast-fuzzy do typo-tolerant matching (Bitap / edit-distance —
 *   a capability the others lack), so they do more work per query — not an
 *   apples-to-apples speed contest.
 * - uFuzzy / match-sorter / fuzzysort / fuzzy keep no persistent index, so their
 *   full cost is inside the query loop; krino, @nozbe/microfuzz, fast-fuzzy and
 *   Fuse prebuild an index once (setup).
 * - fuzzy (mattyork) is a plain substring highlighter (no tiers/typos), included
 *   as the tiny-but-limited floor.
 * - CORPORA: two seeded faker corpora (see corpus.ts) — `ascii` (en only) and
 *   `mixed` (~5% diacritics), benched separately so diacritic cost is visible.
 *   Natural-language names share far fewer prefixes than a combinatorial
 *   word-grid, so they don't flatter trie-based libs (fast-fuzzy). Corpus shape
 *   still moves the numbers — don't read them as universal.
 * - Every configuration comes from configs.ts, so a row timed here is a row
 *   ranked in hits.test.ts. Base rows are library defaults; each lib with
 *   optional features gets a second "(all opts)" line with every opt-in
 *   switched on (diacritic folding, multi-word, ranges/highlight output)
 *   INCLUDING typo modes, which krino carries always-on and cannot disable.
 *   Expect the typo-tolerant rows to return far more rows than the literal
 *   ones (the hits table measures 3–10× the true hit count); rank/MRR, not raw
 *   count, is what makes those rows comparable.
 * The point is positioning, not a leaderboard. Run: `pnpm bench`.
 */
import uFuzzy from "@leeoniya/ufuzzy";
import createMicrofuzz from "@nozbe/microfuzz";
import { Searcher } from "fast-fuzzy";
import Fuse from "fuse.js";
import fuzzysort from "fuzzysort";
import { bench, describe } from "vitest";
import { createFuzzySearch } from "krino";
import { FUSE_BASE, configs } from "./configs.ts";
import { CORPORA } from "./corpus";

// Calibrated sampling: aim for ~1 s of samples per cell, floored at 5
// iterations and capped at 20 — fast cells stop at 20 samples instead of
// burning the budget, slow cells (Fuse/fast-fuzzy at 100k) stop at 5. tinybench's
// `time` and `iterations` are both floors, so the cap is implemented by probing
// each cell once (the probe doubles as warmup) and pinning `iterations`.
const TARGET_MS = 1000;
const calibrated = (fn: () => void): { time: number; iterations: number; warmupTime: number; warmupIterations: number } => {
	const t0 = performance.now();
	fn();
	const oneShot = Math.max(performance.now() - t0, 0.001);
	return {
		time: 0,
		iterations: Math.min(20, Math.max(5, Math.floor(TARGET_MS / oneShot))),
		warmupTime: 0,
		warmupIterations: 1,
	};
};
// Collect the previous task's garbage before this task's warmup and timing
// begin. Bench cells otherwise absorb order-dependent GC debt: an
// allocation-heavy neighbour's collection lands inside the next cell's
// window, which has produced physically impossible orderings (base krino
// timing 2.4x slower than its own strictly-more-code acronym config on a
// loaded machine). A task's own garbage still lands in its own window —
// that part is the task's real cost. No-op without --expose-gc (the bench
// script sets it).
const collectDebt = (): void => {
	(globalThis as { gc?: () => void }).gc?.();
};
const cbench = (name: string, fn: () => void): void => {
	bench(name, fn, { ...calibrated(fn), setup: collectDebt });
};

// Every bench consumes its result into this sink so the JIT can't dead-code
// eliminate result construction. Match-count VALIDITY lives in hits.test.ts.
let sink = 0;

// Scope to a subset of tables with BENCH=<token>[,<token>…] — a token matches a
// corpus (`mixed`), a size (`100k`), or a table (`mixed-100k`). Unset = full
// matrix (the publish ritual); scoped runs are the dev loop.
//   BENCH=mixed-10k pnpm bench
const BENCH_TOKENS = (process.env.BENCH ?? "").toLowerCase().split(",").filter(Boolean);
const sizeLabel = (n: number): string => `${n / 1000}k`;
const wants = (corpus: string, size: number): boolean =>
	BENCH_TOKENS.length === 0 ||
	BENCH_TOKENS.some((t) => t === corpus || t === sizeLabel(size) || t === `${corpus}-${sizeLabel(size)}`);

// No 1k size: every library is sub-ms there (zero decision value) and its
// sub-ms cells sit at timer granularity, so the column only measured jitter.
for (const { name: corpusName, build, queries: QUERIES } of CORPORA)
for (const size of [10000, 100000]) {
	if (!wants(corpusName, size)) continue;
	const list = build(size);
	// Cached prep (latinized haystack, prebuilt indexes) stays outside the query
	// loop, for every configuration alike.
	const all = configs(list);

	describe(`[${corpusName}] query ${size} items × ${QUERIES.length} queries`, () => {
		for (const config of all) {
			cbench(config.name, () => {
				for (const q of QUERIES) sink += config.count(q);
			});
		}
	});

	// Build cost barely differs between corpora — measure it once, on mixed.
	// Constructors only: hits.test.ts measures time-to-ready instead, which for
	// the lazy preparers is a different number.
	if (corpusName === "mixed") {
		describe(`build index (${size} items)`, () => {
			cbench("krino createFuzzySearch", () => {
				createFuzzySearch(list);
			});
			cbench("@nozbe/microfuzz", () => {
				createMicrofuzz(list);
			});
			cbench("fast-fuzzy new Searcher", () => {
				new Searcher(list);
			});
			cbench("fuse.js new Fuse", () => {
				new Fuse(list, FUSE_BASE);
			});
			// fuzzysort has no constructor; this is the prepare-all pass its
			// first go() runs lazily and caches process-wide (see hits.test.ts).
			cbench("fuzzysort prepare (lazy)", () => {
				for (const s of list) sink += fuzzysort.prepare(s).target.length;
			});
			// Base uFuzzy keeps no index, but its (all opts) configuration
			// latinizes the whole haystack once. That is a build, and leaving it
			// unmeasured made the row's total column its query alone.
			cbench("uFuzzy (all opts) latinize", () => {
				sink += uFuzzy.latinize(list).length;
			});
		});
	}
}

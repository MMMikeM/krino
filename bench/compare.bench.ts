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
 * - Each lib with optional features gets a second "(all opts)" line: every
 *   opt-in switched on (diacritic folding, multi-word, ranges/highlight
 *   output) EXCEPT typo modes — krino can't reciprocate, so typo tolerance
 *   stays off everywhere. Base lines are stock defaults.
 * The point is positioning, not a leaderboard. Run: `pnpm bench`.
 */
import uFuzzy from "@leeoniya/ufuzzy";
import createMicrofuzz from "@nozbe/microfuzz";
import { Searcher } from "fast-fuzzy";
import Fuse from "fuse.js";
import { filter as fuzzyFilter } from "fuzzy";
import fuzzysort from "fuzzysort";
import { matchSorter } from "match-sorter";
import { bench, describe } from "vitest";
import { createFuzzySearch } from "krino";
import { CORPORA } from "./corpus";

// Calibrated sampling: aim for ~300 ms of samples per cell, floored at 5
// iterations and capped at 20 — fast cells stop at 20 samples instead of
// burning 300 ms, slow cells (Fuse/fast-fuzzy at 100k) stop at 5. tinybench's
// `time` and `iterations` are both floors, so the cap is implemented by probing
// each cell once (the probe doubles as warmup) and pinning `iterations`.
const TARGET_MS = 300;
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
const cbench = (name: string, fn: () => void): void => {
	bench(name, fn, calibrated(fn));
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
	const mikro = createFuzzySearch(list); // prebuilt index
	const microfuzz = createMicrofuzz(list); // prebuilt index (the parent lib)
	const fastFuzzy = new Searcher(list); // prebuilt index
	const fuse = new Fuse(list, { ignoreLocation: true, threshold: 0.4 });
	const uf = new uFuzzy();

	// "(all opts)" variants — every opt-in on except typo modes. Cached prep
	// (latinized haystack, prebuilt indexes) stays outside the query loop, same
	// as the base lines.
	const mikroAll = createFuzzySearch(list, [{ text: (x: string) => x, acronym: true }]);
	const microfuzzAll = createMicrofuzz(list, { strategy: "aggressive" });
	const fastFuzzyAll = new Searcher(list, { returnMatchData: true });
	const fuseAll = new Fuse(list, {
		ignoreLocation: true,
		threshold: 0.4,
		ignoreDiacritics: true,
		includeMatches: true,
		useExtendedSearch: true,
	});
	const latinized = uFuzzy.latinize(list);
	const OUT_OF_ORDER = 1;

	describe(`[${corpusName}] query ${size} items × ${QUERIES.length} queries`, () => {
		cbench("krino", () => {
			for (const q of QUERIES) sink += mikro(q).length;
		});
		cbench("krino (acronym)", () => {
			for (const q of QUERIES) sink += mikroAll(q).length;
		});
		cbench("@nozbe/microfuzz", () => {
			for (const q of QUERIES) sink += microfuzz(q).length;
		});
		cbench("@nozbe/microfuzz (all opts)", () => {
			for (const q of QUERIES) sink += microfuzzAll(q).length;
		});
		cbench("fuzzy", () => {
			for (const q of QUERIES) sink += fuzzyFilter(q, list).length;
		});
		cbench("fuzzy (all opts)", () => {
			for (const q of QUERIES) sink += fuzzyFilter(q, list, { pre: "<", post: ">" }).length;
		});
		cbench("fuzzysort", () => {
			for (const q of QUERIES) sink += fuzzysort.go(q, list).length;
		});
		cbench("match-sorter", () => {
			for (const q of QUERIES) sink += matchSorter(list, q).length;
		});
		cbench("fast-fuzzy", () => {
			for (const q of QUERIES) sink += fastFuzzy.search(q).length;
		});
		cbench("fast-fuzzy (all opts)", () => {
			for (const q of QUERIES) sink += fastFuzzyAll.search(q).length;
		});
		cbench("uFuzzy", () => {
			for (const q of QUERIES) sink += uf.search(list, q)[0]?.length ?? 0;
		});
		cbench("uFuzzy (all opts)", () => {
			for (const q of QUERIES)
				sink += uf.search(latinized, uFuzzy.latinize([q])[0], OUT_OF_ORDER)[0]?.length ?? 0;
		});
		cbench("fuse.js", () => {
			for (const q of QUERIES) sink += fuse.search(q).length;
		});
		cbench("fuse.js (all opts)", () => {
			for (const q of QUERIES) sink += fuseAll.search(q).length;
		});
	});

	// Build cost barely differs between corpora — measure it once, on mixed.
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
				new Fuse(list, { ignoreLocation: true, threshold: 0.4 });
			});
		});
	}
}

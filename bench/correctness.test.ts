/**
 * Correctness edges: cases krino handles by design that uFuzzy (default config)
 * does not. Not a speed comparison — this documents what krino's extra per-query
 * work buys, and pins the behaviours the front-of-ladder pre-filter must preserve
 * (the reason it's an order-independent presence gate, not a subsequence gate,
 * for multi-word queries).
 */
import uFuzzy from "@leeoniya/ufuzzy";
import { describe, expect, it } from "vite-plus/test";
import { createFuzzySearch, fuzzyMatch } from "krino";

const uf = new uFuzzy(); // defaults: in-order, no diacritic folding

// uFuzzy.filter returns matched indices, or [] / null when nothing matches.
const uFuzzyMatches = (haystack: string[], needle: string): boolean => {
	const idxs = uf.filter(haystack, needle);
	return idxs != null && idxs.length > 0;
};

describe("krino correctness edges over uFuzzy (default config)", () => {
	it("matches query words out of order; uFuzzy is in-order by default", () => {
		// krino's multi-word tier matches all query words in any order.
		expect(fuzzyMatch("hello world", "world hello")?.tier).toBe("multi-word");
		expect(uFuzzyMatches(["hello world"], "world hello")).toBe(false);
		// Sanity: uFuzzy DOES match the same words in order — so the miss above is
		// ordering, not a broken setup.
		expect(uFuzzyMatches(["hello world"], "hello world")).toBe(true);
	});

	it("folds diacritics by default; uFuzzy needs an opt-in latinize()", () => {
		expect(fuzzyMatch("café", "cafe")).not.toBeNull();
		expect(uFuzzyMatches(["café"], "cafe")).toBe(false);
	});

	it("createFuzzySearch surfaces the out-of-order hit that uFuzzy drops", () => {
		const items = ["the event loop", "hello world", "async engine"];
		const hits = createFuzzySearch(items)("loop event"); // reversed order
		expect(hits.map((h) => h.item)).toContain("the event loop");
		expect(uFuzzyMatches(items, "loop event")).toBe(false);
	});
});

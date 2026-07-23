/**
 * The fuzzyMatch primitive: score one string → { score, tier, ranges } | null.
 * Every tier is asserted with its score AND its categorical `tier` name.
 */
import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../src/index";

describe("result shape", () => {
	it("returns { score, tier, ranges }", () => {
		expect(fuzzyMatch("banana", "ban")).toEqual({ score: 0.5, tier: "prefix", ranges: [[0, 2]] });
	});

	it("returns null when nothing matches", () => {
		expect(fuzzyMatch("cherry", "xyz")).toBeNull();
	});
});

describe("tier ladder", () => {
	it.each([
		["Apple", "Apple", 0, "exact", [[0, 4]]],
		["Apple", "apple", 0.1, "normalized-exact", [[0, 4]]],
		["Café", "cafe", 0.1, "normalized-exact", [[0, 3]]],
		["banana", "ban", 0.5, "prefix", [[0, 2]]],
		["Hello World", "World", 0.9, "boundary-exact", [[6, 10]]],
		["Hello World", "world", 1, "boundary", [[6, 10]]],
		["Hello World", "wor", 1, "boundary", [[6, 8]]],
		["well-known", "known", 0.9, "boundary-exact", [[5, 9]]],
		["concatenate", "cat", 2, "contains", [[3, 5]]],
	] as const)("%j / %j → %s (%s)", (text, query, score, tier, ranges) => {
		const r = fuzzyMatch(text, query);
		expect(r?.score).toBe(score);
		expect(r?.tier).toBe(tier);
		expect(r?.ranges).toEqual(ranges);
	});

	it("multi-word: all query words present, any order", () => {
		const r = fuzzyMatch("the quick brown fox", "fox quick");
		expect(r?.score).toBe(1.5);
		expect(r?.tier).toBe("multi-word");
		expect(r?.ranges).toEqual([
			[4, 8],
			[16, 18],
		]);
	});

	it("multi-word: words separated by non-boundary punctuation still get real ranges", () => {
		const r = fuzzyMatch("foo@bar", "foo bar");
		expect(r?.score).toBe(1.5);
		expect(r?.tier).toBe("multi-word");
		expect(r?.ranges).toEqual([
			[0, 2],
			[4, 6],
		]);
	});

	it("fuzzy fallback: score > 2, tier 'fuzzy'", () => {
		const r = fuzzyMatch("big cat", "bigcat");
		expect(r?.score).toBeGreaterThan(2);
		expect(r?.tier).toBe("fuzzy");
		expect(r?.ranges).toEqual([
			[0, 2],
			[4, 6],
		]);
	});
});

describe("edge cases", () => {
	it("empty text → null", () => {
		expect(fuzzyMatch("", "a")).toBeNull();
	});

	it("query longer than text → null", () => {
		expect(fuzzyMatch("cat", "catalog")).toBeNull();
	});

	it("empty query → null", () => {
		expect(fuzzyMatch("abc", "")).toBeNull();
	});
});

describe("range semantics", () => {
	it("ranges are [start, end] inclusive", () => {
		const [start, end] = fuzzyMatch("Hello World", "wor")!.ranges[0]!;
		expect("Hello World".slice(start, end + 1)).toBe("Wor");
	});
});

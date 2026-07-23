/**
 * Fuzzy chunk scoring (the "fuzzy" tier), exercised through the primitive.
 * Fuzzy scores are runtime sums → toBeCloseTo.
 */
import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../src/index";

describe("smart chunk scoring", () => {
	it("word-boundary chunks", () => {
		const r = fuzzyMatch("hello world", "hewo");
		expect(r?.score).toBeCloseTo(2.8); // 2 + 0.4 + 0.4 (two word-start chunks)
		expect(r?.ranges).toEqual([
			[0, 1],
			[6, 7],
		]);
	});

	it("mid-word chunks of 3+ characters", () => {
		const r = fuzzyMatch("xylophone tuner", "phonetun");
		expect(r?.score).toBeCloseTo(3.2); // 2 + 0.8 (len-5 mid-word) + 0.4 (word start)
		expect(r?.ranges).toEqual([
			[4, 8],
			[10, 12],
		]);
	});

	it("full-word chunks are cheapest", () => {
		const r = fuzzyMatch("big cat", "bigcat");
		expect(r?.score).toBeCloseTo(2.4); // 2 + 0.2 + 0.2
		expect(r?.ranges).toEqual([
			[0, 2],
			[4, 6],
		]);
	});

	it("word-start chunks cost more than whole words", () => {
		const r = fuzzyMatch("sad unknown night", "sun");
		expect(r?.score).toBeCloseTo(2.8); // 2 + 0.4 + 0.4
		expect(r?.ranges).toEqual([
			[0, 0],
			[4, 5],
		]);
	});

	it("rejects short mid-word chunks", () => {
		expect(fuzzyMatch("abcdef", "adf")).toBeNull();
	});
});

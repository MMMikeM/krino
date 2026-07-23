/**
 * Regression tests for the issues catalogued in the v0.x KNOWN-ISSUES
 * document (since folded into the CHANGELOG).
 *
 * All six bugs are now fixed; these assertions pin the corrected behaviour so
 * the fixes can't silently regress. (This file used to be an `it.fails` tracker
 * for the unfixed bugs — see git history.)
 */
import { describe, expect, it } from "vitest";
import { createFuzzySearch, fuzzyMatch } from "../src/index";

describe("bug 1: punctuation is a word boundary", () => {
	it("a comma glued to a word does not change its tier", () => {
		const withComma = fuzzyMatch("Fail the build, not the runtime", "build runtime");
		const without = fuzzyMatch("Fail the build not the runtime", "build runtime");
		expect(withComma?.score).toBeCloseTo(without!.score);
		expect(withComma?.score).toBeCloseTo(1.5); // multi-word tier, comma stripped
	});

	it("'.' is a word boundary like ' ' and '-'", () => {
		expect(fuzzyMatch("foo bar", "bar")?.score).toBe(0.9);
		expect(fuzzyMatch("foo.bar", "bar")?.score).toBe(0.9);
	});
});

describe("bug 2: boundary-contains scans past mid-word occurrences", () => {
	it("a later occurrence at a word boundary earns the boundary tier", () => {
		expect(fuzzyMatch("actor factor model", "actor")?.score).toBe(0.5); // prefix
		expect(fuzzyMatch("factor actor model", "actor")?.score).toBe(0.9); // standalone 'actor'
	});
});

describe("bug 3: highlight ranges land on the standalone word", () => {
	it("range covers the standalone 'cat' at index 16, not con[cat]enate", () => {
		expect(fuzzyMatch("concatenate the cat", "cat")?.ranges).toEqual([[16, 18]]);
	});
});

describe("bug 4: multi-word tier does not penalise specificity", () => {
	it("a more specific all-words match never ranks worse", () => {
		const text = "lag story of the event and the loop";
		const two = fuzzyMatch(text, "event loop")!.score;
		const three = fuzzyMatch(text, "event loop lag")!.score;
		expect(three).toBeLessThanOrEqual(two);
	});
});

describe("bug 5: fuzzyMatch rejects an empty query", () => {
	it("empty query matches nothing, like createFuzzySearch", () => {
		expect(fuzzyMatch("abc", "")).toBeNull();
		expect(createFuzzySearch(["abc"])("")).toEqual([]);
	});
});

describe("bug 6: highlight width uses the normalized query length", () => {
	it("padding in the query does not widen the highlight", () => {
		expect(fuzzyMatch("Hello World", "wor")?.ranges).toEqual([[6, 8]]);
		expect(fuzzyMatch("Hello World", " wor ")?.ranges).toEqual([[6, 8]]);
	});
});

describe("hazard (documentation, not a bug): smart fuzzy over long text", () => {
	// Still true after the fixes: chunks only need a word-boundary start or a
	// 3-char run, so short queries assemble junk chains over long vocabulary.
	// Scope smart to short labels; the density floor rejects sparse chains.
	it("'zebra' still matches text containing only 'zero' and 'branch'", () => {
		const result = fuzzyMatch("zero cost branch prediction and other stories", "zebra");
		expect(result).not.toBeNull();
		expect(result!.score).toBeGreaterThan(2);
	});
});

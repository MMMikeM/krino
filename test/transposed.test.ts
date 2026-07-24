/**
 * The transposition rescue: a single adjacent-swap typo ("geenric" for
 * "generic") breaks the subsequence property while preserving the character
 * multiset, so the field sits inside the mask gate but fails every tier. The
 * rescue detects the swap, reruns the ladder with the corrected query, and
 * returns the underlying tier's result demoted by a penalty under the
 * "transposed" tier. It fires only where everything else failed, so existing
 * matches can never change.
 */
import { describe, expect, it } from "vitest";
import { createFuzzySearch, fuzzyMatch } from "../src/index";

describe("transposed tier", () => {
	it("rescues an adjacent-swap typo to the corrected tier plus penalty", () => {
		// corrected "generic" is an exact hit (0) → 0 + 0.9
		const result = fuzzyMatch("generic", "geenric");
		expect(result?.tier).toBe("transposed");
		expect(result?.score).toBeCloseTo(0.9);
	});

	it("rescues into whatever tier the corrected query earns", () => {
		// corrected "generic" is a prefix (0.5) of the field → 0.5 + 0.9
		const result = fuzzyMatch("generic gasket", "geenric");
		expect(result?.tier).toBe("transposed");
		expect(result?.score).toBeCloseTo(1.4);
	});

	it("ranges come from the corrected match", () => {
		expect(fuzzyMatch("generic gasket", "geenric")?.ranges).toEqual([[0, 6]]);
	});

	it("never fires when the original query matches", () => {
		// "trail" genuinely fuzzy-matches... or misses; either way the result
		// must not silently become a rescued "trial" swap when a real tier hit
		// exists. Contains here: "geenric" inside the field verbatim.
		expect(fuzzyMatch("the geenric one", "geenric")?.tier).toBe("boundary-exact");
	});

	it("stays out of short queries", () => {
		// Three-character strings transpose into noise ("hte" → "the").
		expect(fuzzyMatch("the", "hte")).toBeNull();
	});

	it("requires the full character multiset", () => {
		// A transposition never changes which characters are present; a query
		// with a wrong character must stay a miss, not get creatively swapped.
		expect(fuzzyMatch("generic", "geenrix")).toBeNull();
	});

	it("rescued items rank above junk subsequence chains", () => {
		const results = createFuzzySearch(["generic gasket", "grabbing electric nickel rugs"])(
			"geenric",
		);
		expect(results[0]?.item).toBe("generic gasket");
		expect(results[0]?.fields[0]?.tier).toBe("transposed");
	});

	it("real-word neighbours match with the penalty visible", () => {
		// "trial" ↔ "trail" are mutual transpositions of real words; the rescue
		// finds it, and the 0.9 penalty keeps it below any true tier hit.
		const result = fuzzyMatch("trial", "trail");
		expect(result?.tier).toBe("transposed");
		expect(result!.score).toBeCloseTo(0.9); // corrected exact + penalty
	});
});

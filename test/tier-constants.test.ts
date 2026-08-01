/**
 * The exported SCORES tier constants.
 */
import { describe, expect, it } from "vite-plus/test";
import { fuzzyMatch, SCORES } from "../src/index";

describe("SCORES", () => {
	it("matches the documented tier ladder", () => {
		expect(SCORES).toEqual({
			EXACT: 0,
			NORMALISED_EXACT: 0.1,
			PREFIX: 0.5,
			BOUNDARY_EXACT: 0.9,
			BOUNDARY: 1,
			MULTI_WORD: 1.5,
			ACRONYM: 1.8,
			CONTAINS: 2,
		});
	});

	it("is importable as a runtime value", () => {
		expect(typeof SCORES.CONTAINS).toBe("number");
	});

	it("`score <= SCORES.CONTAINS` selects non-fuzzy matches", () => {
		expect(fuzzyMatch("concatenate", "cat")!.score).toBeLessThanOrEqual(SCORES.CONTAINS); // contains
		expect(fuzzyMatch("big cat", "bigcat")!.score).toBeGreaterThan(SCORES.CONTAINS); // fuzzy
	});
});

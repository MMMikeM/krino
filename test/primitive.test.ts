/**
 * fuzzyMatch options: acronym.
 */
import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../src/index";

describe("fuzzy fallback", () => {
	it("assembles compact chunk matches", () => {
		expect(fuzzyMatch("big cat", "bigcat")?.tier).toBe("fuzzy");
	});

	it("rejects short mid-word chunks", () => {
		expect(fuzzyMatch("abcdef", "adf")).toBeNull();
	});
});

describe("acronym option", () => {
	it("is off by default (initials fall to the fuzzy tier, not acronym)", () => {
		expect(fuzzyMatch("United States", "us")?.tier).toBe("fuzzy");
	});

	it("matches word initials when enabled", () => {
		const r = fuzzyMatch("United States", "us", { acronym: true });
		expect(r?.score).toBe(1.8);
		expect(r?.tier).toBe("acronym");
		expect(r?.ranges).toEqual([
			[0, 0],
			[7, 7],
		]);
	});
});

/**
 * fuzzyMatch options: strategy and acronym.
 */
import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../src/index";

describe("strategy option", () => {
	it("defaults to smart", () => {
		expect(fuzzyMatch("big cat", "bigcat")?.tier).toBe("fuzzy");
	});

	it("'off' disables the fuzzy fallback", () => {
		expect(fuzzyMatch("big cat", "bigcat", { strategy: "off" })).toBeNull();
		// non-fuzzy tiers still work
		expect(fuzzyMatch("big cat", "big", { strategy: "off" })?.tier).toBe("prefix");
	});

	it("'smart' rejects short mid-word chunks", () => {
		expect(fuzzyMatch("abcdef", "adf", { strategy: "smart" })).toBeNull();
	});
});

describe("acronym option", () => {
	it("is off by default (fuzzy still matches, but not as acronym)", () => {
		expect(fuzzyMatch("United States", "us", { strategy: "off" })).toBeNull();
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

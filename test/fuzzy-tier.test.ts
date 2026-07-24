/**
 * Fuzzy chunk scoring and the density floor (the "fuzzy" tier), exercised
 * through the primitive.
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

describe("scorer honors the same word boundaries as the matcher", () => {
	// The matcher admits chunks after any valid word boundary (hyphens, dots,
	// quotes...); the scorer must credit them like space-delimited chunks, or
	// punctuated corpora get systematically over-penalized for the exact
	// chunks the matcher went out of its way to admit.
	it("scores a chunk after a hyphen like one after a space", () => {
		expect(fuzzyMatch("foo-bar", "fbar")?.score).toBeCloseTo(
			fuzzyMatch("foo bar", "fbar")?.score as number,
		);
	});

	it("scores a short boundary chunk as a word start, not scattered", () => {
		const r = fuzzyMatch("foo-bar", "fba");
		expect(r?.score).toBeCloseTo(2.8); // 2 + 0.4 (word-start "f") + 0.4 (word-start "ba")
	});

	it("credits whole-word chunks delimited by punctuation", () => {
		expect(fuzzyMatch("bar-foo", "barf")?.score).toBeCloseTo(
			fuzzyMatch("bar foo", "barf")?.score as number,
		);
	});

	describe("one boundary definition: any non-word character", () => {
		// The boundary set used to be an enumerated allowlist that silently
		// diverged from the tokenizer's word class: "?" separated words for
		// splitWords but wasn't a boundary for the boundary tier or the chunk
		// scorer. One predicate now: a boundary is any non-word character.
		it("the boundary tiers fire across every separator splitWords honors", () => {
			for (const sep of ["?", "&", "!", "+", "@", "#", "*", "\t"]) {
				// Same case → the raw boundary-exact tier (0.9); previously these
				// all fell through to contains (2).
				expect(fuzzyMatch(`foo${sep}bar`, "bar")?.tier, `sep ${JSON.stringify(sep)}`).toBe(
					"boundary-exact",
				);
				expect(fuzzyMatch(`FOO${sep}BAR`, "bar")?.tier, `sep ${JSON.stringify(sep)}`).toBe(
					"boundary",
				);
			}
		});

		it("chunk scoring parity holds for the widened separators", () => {
			expect(fuzzyMatch("foo&bar", "fbar")?.score).toBeCloseTo(
				fuzzyMatch("foo bar", "fbar")?.score as number,
			);
		});
	});
});

describe("fuzzy density floor", () => {
	it("rejects sparse chains scattered across long text", () => {
		// Word-start single-char chunks across ~25 chars: density 3/21 ≈ 0.14,
		// below the 0.18 floor — the junk-chain shape that plagued documents.
		expect(fuzzyMatch("alpha xxxxxx beta xxxxxx cat", "abc")).toBeNull();
	});

	it("keeps compact word-start assemblies", () => {
		// "hewo" over "hello world": density 4/8 = 0.5 — well above the floor.
		expect(fuzzyMatch("hello world", "hewo")?.tier).toBe("fuzzy");
		// Adjacent-word assembly at 0.38 (the documented zebra anecdote) stays:
		// structurally identical to wanted word-start matches.
		expect(fuzzyMatch("zero cost branch prediction", "zebra")?.tier).toBe("fuzzy");
	});

	it("keeps initials scattered across a multi-word name", () => {
		// The sparsest genuine shape measured: 4/19 ≈ 0.21, just above the floor.
		expect(fuzzyMatch("Rath, Streich and Witting", "rsaw")?.tier).toBe("fuzzy");
	});
});

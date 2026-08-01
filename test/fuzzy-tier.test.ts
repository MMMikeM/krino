// Fuzzy scores are runtime float sums, so every score assertion is toBeCloseTo.
import { describe, expect, it } from "vite-plus/test";
import { fuzzyMatch } from "../src/index";

describe("fuzzy chunk scoring", () => {
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

describe("scorer honours the same word boundaries as the matcher", () => {
	// The scorer must credit every chunk the matcher admits, or punctuated
	// corpora get over-penalised for the exact chunks admission allowed.
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
		it("the boundary tiers fire across every separator splitWords honours", () => {
			for (const sep of ["?", "&", "!", "+", "@", "#", "*", "\t"]) {
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

describe("chunk assembly reconsiders its first choice", () => {
	// Leftmost-only first chunks strand on decoy word-initials: 307 misses and
	// 131 needlessly expensive assemblies over the ascii bench corpus.

	describe("finds the intended word past a decoy initial", () => {
		// "corrected" is the point: the first-chunk retry produces the clean
		// two-chunk assembly the dropped-keystroke rescue then recognises.
		it("matches inside the intended word past an earlier word-initial", () => {
			const r = fuzzyMatch("Tasty Silk Towels", "towls");
			expect(r?.tier).toBe("corrected");
			expect(r?.corrected).toBe("towels");
			expect(r?.score).toBeCloseTo(3.1); // boundary (1) + typo penalty (2.1)
			expect(r?.ranges).toEqual([[11, 16]]);
		});

		it("skips a decoy initial two words back", () => {
			const r = fuzzyMatch("New Mistyborough, San Marino", "marno");
			expect(r?.score).toBeCloseTo(3.1);
			expect(r?.ranges).toEqual([[22, 27]]);
		});

		it("skips a decoy initial across a punctuated boundary", () => {
			const r = fuzzyMatch("South Eliseboro, Serbia", "seria");
			expect(r?.score).toBeCloseTo(3.1);
			expect(r?.ranges).toEqual([[17, 22]]);
		});

		it("absorbs a decoy instead of paying for it as a lone chunk", () => {
			const r = fuzzyMatch("Milwaukee, Malaysia", "malasia");
			expect(r?.score).toBeCloseTo(3.1);
			expect(r?.ranges).toEqual([[11, 18]]);
		});

		it("does not pay for a leading singleton when the word itself matches", () => {
			const r = fuzzyMatch("Pfeffer - Predovic", "predvic");
			expect(r?.score).toBeCloseTo(3.1);
			expect(r?.ranges).toEqual([[10, 17]]);
		});

		it("prefers the real word over a split assembly", () => {
			const r = fuzzyMatch("Port Pasqualefurt, Bolivia", "pasquaefurt");
			expect(r?.score).toBeCloseTo(3.1);
			expect(r?.ranges).toEqual([[5, 16]]);
		});
	});

	describe("still assembles when no single edit explains the query", () => {
		it("recovers a three-chunk assembly the leftmost path missed", () => {
			const r = fuzzyMatch("Wiegand, Weissnat and Harris", "wead");
			expect(r?.tier).toBe("fuzzy");
			expect(r?.score).toBeCloseTo(4.4); // 2 + 0.4 + 1.6 + 0.4
			expect(r?.ranges).toEqual([
				[9, 10],
				[18, 18],
				[20, 20],
			]);
		});

		it("skips a stranding decoy when the gap is a separator, not a typo", () => {
			const r = fuzzyMatch(`a${"z".repeat(60)}abc-e`, "abce");
			expect(r?.tier).toBe("fuzzy");
			expect(r?.score).toBeCloseTo(3); // 2 + 0.8 (mid-word "abc") + 0.2 (whole-word "e")
			expect(r?.ranges).toEqual([
				[61, 63],
				[65, 65],
			]);
		});
	});

	describe("reconsidering does not widen what the tier accepts", () => {
		it("still rejects sparse chains scattered across long text", () => {
			expect(fuzzyMatch("alpha xxxxxx beta xxxxxx cat", "abc")).toBeNull();
		});

		it("still rejects short mid-word chunks", () => {
			expect(fuzzyMatch("abcdef", "adf")).toBeNull();
		});

		it("gives up after a bounded number of first-chunk placements", () => {
			// Load-bearing bound, not a speed knob (see MAX_CHUNK_STARTS): four
			// decoy initials is past the cap, so this buried match is refused —
			// the price of holding the long-text junk rate at zero.
			expect(fuzzyMatch("Tasty Tidy Trim Tall Towels", "towls")).toBeNull();
			expect(fuzzyMatch("Tasty Tidy Trim Towels", "towls")?.tier).toBe("corrected");
		});

		it("leaves the documented zebra hazard scored exactly as before", () => {
			const r = fuzzyMatch("zero cost branch prediction and other stories", "zebra");
			expect(r?.score).toBeCloseTo(2.8); // 2 + 0.4 ("ze") + 0.4 ("bra")
			expect(r?.ranges).toEqual([
				[0, 1],
				[10, 12],
			]);
		});
	});
});

describe("fuzzy density floor", () => {
	it("rejects sparse chains scattered across long text", () => {
		// Density 3/21 ≈ 0.14, below the 0.18 floor — the junk-chain shape.
		expect(fuzzyMatch("alpha xxxxxx beta xxxxxx cat", "abc")).toBeNull();
	});

	it("keeps compact word-start assemblies", () => {
		// Densities 0.5 and 0.38 — the zebra anecdote is structurally identical
		// to wanted word-start matches.
		expect(fuzzyMatch("hello world", "hewo")?.tier).toBe("fuzzy");
		expect(fuzzyMatch("zero cost branch prediction", "zebra")?.tier).toBe("fuzzy");
	});

	it("keeps initials scattered across a multi-word name", () => {
		// The sparsest genuine shape measured: 4/19 ≈ 0.21.
		expect(fuzzyMatch("Rath, Streich and Witting", "rsaw")?.tier).toBe("fuzzy");
	});
});

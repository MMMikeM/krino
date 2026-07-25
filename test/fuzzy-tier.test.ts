/**
 * Fuzzy chunk assembly, chunk scoring, and the density floor (the "fuzzy"
 * tier), exercised through the primitive.
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

describe("chunk assembly reconsiders its first choice", () => {
	// The matcher used to take the leftmost admissible occurrence of each query
	// character and never look back. In natural-language fields the first query
	// character almost always also opens an *earlier* word ("towls" → the "T" of
	// "Tasty", not the "T" of "Towels"), and committing to that decoy strands the
	// rest of the query: it must then assemble from whatever follows, or fail
	// outright. Measured over the ascii bench corpus: 307 outright misses and 131
	// needlessly expensive assemblies.

	describe("finds the intended word past a decoy initial", () => {
		// These land on the "deleted" tier rather than "fuzzy", and that is the
		// point: retrying the first chunk is what produces the clean two-chunk
		// assembly, and a two-chunk assembly split by one character is exactly
		// what the dropped-keystroke rescue recognises. Without the retry the
		// chain returns nothing (or a three-chunk scatter) and there is nothing
		// for the rescue to read.
		it("matches inside the intended word past an earlier word-initial", () => {
			const r = fuzzyMatch("Tasty Silk Towels", "towls");
			expect(r?.tier).toBe("deleted");
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

		it("absorbs a decoy that the old matcher paid for as a lone chunk", () => {
			// Previously assembled as [[0,0],[12,14],[16,18]] — a 1-char chunk on
			// the "M" of "Milwaukee" plus two fragments — and scored 4.0.
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
		// Pure fuzzy-tier coverage: three chunks, so the dropped-keystroke rescue
		// cannot fire and what is asserted is the assembly itself.
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
			// One decoy "a" at index 0 strands the chain; the real assembly sits at
			// the end. The gap between its two chunks is "-", a word separator, so
			// this stays an assembly rather than being read as a dropped keystroke.
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
		// Exploring more assemblies means more chances to slip past the density
		// floor and the chunk-admission rules — and over long text that is exactly
		// what happens (see fuzzy.ts). These pin the rules that hold the line.
		it("still rejects sparse chains scattered across long text", () => {
			expect(fuzzyMatch("alpha xxxxxx beta xxxxxx cat", "abc")).toBeNull();
		});

		it("still rejects short mid-word chunks", () => {
			expect(fuzzyMatch("abcdef", "adf")).toBeNull();
		});

		it("gives up after a bounded number of first-chunk placements", () => {
			// The bound is deliberate and load-bearing, not a speed knob: the
			// density floor is a ratio, so every extra assembly attempted is
			// another chance at a dense coincidence, and an unbounded search
			// makes the long-text junk rate climb with field length (measured in
			// fuzzy.ts). Four decoy word-initials before the real word is past
			// the cap, so this correctly-spelled-but-buried match is refused —
			// the price of holding the junk rate at zero.
			expect(fuzzyMatch("Tasty Tidy Trim Tall Towels", "towls")).toBeNull();
			// Three decoys is still within it.
			expect(fuzzyMatch("Tasty Tidy Trim Towels", "towls")?.tier).toBe("deleted");
		});

		it("leaves the documented long-text hazard scored exactly as before", () => {
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

/**
 * Acronym tier ranking/precedence. (Basic match is in primitive.test.ts; the
 * per-field toggle is in fields.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { createFuzzySearch, fuzzyMatch, SCORES } from "../src/index";

describe("acronym tier", () => {
	it("does not fire when an earlier tier matches", () => {
		// "us army" starts with "us" → prefix wins
		expect(fuzzyMatch("us army", "us", { acronym: true })?.tier).toBe("prefix");
	});

	it("wins over contains when one field matches both ways", () => {
		// The ladder must be monotonic in score: acronym (1.8) beats contains
		// (2), so a field that matches both ways gets the better tier. The
		// initials of "Universal Studios campus" are "usc"; "campus" also
		// contains "us" as a substring.
		const result = fuzzyMatch("Universal Studios campus", "us", { acronym: true });
		expect(result?.tier).toBe("acronym");
		expect(result?.ranges).toEqual([
			[0, 0],
			[10, 10],
		]);
	});

	it("ranks an acronym match above an incidental contains", () => {
		const results = createFuzzySearch(
			["United States", "campus tour"],
			[{ text: (s) => s, acronym: true }],
		)("us");
		expect(results.map((r) => r.item)).toEqual(["United States", "campus tour"]);
		expect(results[0]!.score).toBe(SCORES.ACRONYM); // 1.8
		expect(results[1]!.score).toBe(SCORES.CONTAINS); // 2 ("us" inside "campus")
	});

	describe("apostrophes stay word-internal", () => {
		// A possessive must not inject a phantom initial: "People's" is one
		// word with initial "p", not "people" + "s". Otherwise the real-world
		// initialism (Lao PDR) can never match its own name.
		it("matches the initialism across an ASCII apostrophe", () => {
			const result = fuzzyMatch("Lao People's Democratic Republic", "lpdr", { acronym: true });
			expect(result?.tier).toBe("acronym");
			// Ranges point at the four word-initial characters.
			expect(result?.ranges).toEqual([
				[0, 0],
				[4, 4],
				[13, 13],
				[24, 24],
			]);
		});

		it("matches the initialism across a typographic apostrophe", () => {
			// faker (and real text) emits U+2019 — both forms must behave alike.
			expect(fuzzyMatch("Lao People’s Democratic Republic", "lpdr", { acronym: true })?.tier).toBe(
				"acronym",
			);
		});

		it("does not treat the possessive s as an initial", () => {
			// Before the fix, initials were "l p s d r" and "lpsdr" matched.
			expect(
				fuzzyMatch("Lao People's Democratic Republic", "lpsdr", { acronym: true })?.tier,
			).not.toBe("acronym");
		});

		it("matches a possessive company initialism", () => {
			// Phantom "s" would land between "j" and "h" and break contiguity.
			expect(fuzzyMatch("Ben & Jerry's Homemade", "bjh", { acronym: true })?.tier).toBe("acronym");
		});
	});

	it("does not skip stopwords (documented scope limit)", () => {
		// Real-world "DRC" drops "of the"; krino's tier is contiguous initials
		// only — locale stopword lists are deliberately out of scope. The
		// density floor rejects the sparse d/r/c chain too, so the query
		// doesn't match at all.
		expect(fuzzyMatch("Democratic Republic of the Congo", "drc", { acronym: true })?.tier).not.toBe(
			"acronym",
		);
	});
});

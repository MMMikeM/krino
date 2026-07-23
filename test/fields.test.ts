/**
 * Per-field search: an array of field specs with independent acronym / atBest,
 * plus the FuzzyResult invariants (fields alignment, score = min).
 */
import { describe, expect, it } from "vitest";
import { createFuzzySearch, SCORES } from "../src/index";

type Post = { title: string; body: string; tags?: string[] };

describe("field specs", () => {
	it("scores each field independently", () => {
		const posts: Post[] = [{ title: "Event Loop", body: "the javascript runtime model" }];
		const r = createFuzzySearch(posts, [{ text: (p) => p.title }, { text: (p) => p.body }])(
			"loop",
		)[0]!;
		expect(r.fields[0]).toEqual({ score: 1, tier: "boundary", ranges: [[6, 9]] });
		expect(r.fields[1]).toBeNull(); // "loop" is no compact chunk assembly of the body
		expect(r.score).toBe(1);
	});

	it("atBest shifts the field's score and the min", () => {
		const posts: Post[] = [{ title: "cat", body: "cat" }];
		const r = createFuzzySearch(posts, [
			{ text: (p) => p.title },
			{ text: (p) => p.body, atBest: 2 },
		])("cat")[0]!;
		expect(r.fields[0]?.score).toBe(0); // exact
		expect(r.fields[1]?.score).toBe(2); // exact 0 shifted to atBest 2
		expect(r.fields[1]?.tier).toBe("exact"); // tier is the raw match tier
		expect(r.score).toBe(0);
	});

	it("atBest keeps body from outranking title", () => {
		const posts: Post[] = [
			{ title: "Redux Toolkit stuff", body: "unrelated text" }, // A: title prefix (0.5)
			{ title: "unrelated title", body: "Redux" }, // B: body normalized-exact (0.1)
		];
		const fields = [
			{ text: (p: Post) => p.title },
			{ text: (p: Post) => p.body, atBest: SCORES.CONTAINS },
		];
		expect(createFuzzySearch(posts, fields)("redux")[0]!.item.title).toBe("Redux Toolkit stuff");
		// without atBest, the body match wins
		const unshifted = fields.map((f) => ({ text: f.text }));
		expect(createFuzzySearch(posts, unshifted)("redux")[0]!.item.title).toBe("unrelated title");
	});

	it("tolerates null field texts", () => {
		const posts: Post[] = [{ title: "hello", body: "world" }];
		const r = createFuzzySearch(posts, [{ text: () => null }, { text: (p) => p.title }])(
			"hello",
		)[0]!;
		expect(r.fields[0]).toBeNull();
		expect(r.fields[1]?.tier).toBe("exact");
	});

	it("acronym can be toggled per field", () => {
		const items = [{ name: "United States", note: "United States" }];
		const r = createFuzzySearch(items, [
			{ text: (i) => i.name, acronym: true },
			{ text: (i) => i.note, acronym: false },
		])("us")[0]!;
		expect(r.fields[0]?.tier).toBe("acronym");
		expect(r.fields[1]?.tier).toBe("fuzzy"); // same text, acronym off → falls to the fuzzy tier
	});
});

describe("FuzzyResult invariants", () => {
	const search = createFuzzySearch(
		[{ a: "hello world", b: "xyz" }],
		[{ text: (i) => i.a }, { text: (i) => i.b }],
	);

	it("fields is parallel to the specs, null where no match", () => {
		const r = search("world")[0]!;
		expect(r.fields).toHaveLength(2);
		expect(r.fields[0]?.tier).toBe("boundary-exact"); // all-lowercase "hello world"
		expect(r.fields[1]).toBeNull();
	});

	it("score equals the minimum of the matched fields' scores", () => {
		const r = createFuzzySearch(
			[{ a: "pineapple", b: "app store" }],
			[{ text: (i) => i.a }, { text: (i) => i.b }],
		)("app")[0]!;
		const matched = r.fields.filter((f) => f !== null).map((f) => f!.score);
		expect(r.score).toBe(Math.min(...matched));
	});
});

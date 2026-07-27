import { describe, expect, it } from "vitest";
import { SCORES } from "../src/index";
import { createFuzzySearch, fuzzyMatch } from "../src/index";

const FILLER = [
	"Rustic Steel Table",
	"Ergonomic Cotton Chair",
	"Sleek Granite Lamp",
	"Practical Bronze Shelf",
	"Modern Plastic Keyboard",
];

describe("one-edit corrections inside a phrase", () => {
	it("one wrong character in the first word matches the corrected phrase", () => {
		const m = fuzzyMatch("Handcrafted Wooden Duck", "handcxafted wooden");
		expect(m?.tier).toBe("corrected");
		expect(m?.corrected).toBe("handcrafted wooden");
		expect(m?.score).toBeCloseTo(SCORES.PREFIX + 2.1);
	});

	it("one wrong character in the second word matches too", () => {
		const m = fuzzyMatch("Handcrafted Wooden Duck", "handcrafted woodxn");
		expect(m?.tier).toBe("corrected");
		expect(m?.corrected).toBe("handcrafted wooden");
	});

	it("the correction survives reversed word order", () => {
		const m = fuzzyMatch("Handcrafted Wooden Duck", "wooden handcxafted");
		expect(m?.tier).toBe("corrected");
		expect(m?.corrected).toBe("wooden handcrafted");
		expect(m?.score).toBeCloseTo(SCORES.MULTI_WORD + 2.1);
	});

	it("a swapped pair inside a phrase word is corrected", () => {
		const m = fuzzyMatch("Handcrafted Wooden Duck", "hadncrafted wooden");
		expect(m?.tier).toBe("corrected");
		expect(m?.corrected).toBe("handcrafted wooden");
	});

	it("a doubled keystroke inside a phrase word is corrected", () => {
		const m = fuzzyMatch("Handcrafted Wooden Duck", "handcraafted wooden");
		expect(m?.tier).toBe("corrected");
		expect(m?.corrected).toBe("handcrafted wooden");
	});

	it("a dropped keystroke inside a phrase word is corrected", () => {
		const m = fuzzyMatch("Handcrafted Wooden Duck", "handcrafed wooden");
		expect(m?.tier).toBe("corrected");
		expect(m?.corrected).toBe("handcrafted wooden");
	});

	it("two mistyped words return nothing — two edits are a guess, not a correction", () => {
		expect(fuzzyMatch("Handcrafted Wooden Duck", "handcxafted woodxn")).toBeNull();
	});

	it("a mistyped word under four characters is not corrected", () => {
		expect(fuzzyMatch("Big Oak Table", "bxg oak")).toBeNull();
	});

	it("words present only inside larger words are not treated as typos", () => {
		const m = fuzzyMatch("Woodpecker Duckling", "wood duck");
		expect(m?.tier).not.toBe("corrected");
	});

	it("the correction keeps the caller's own casing", () => {
		const m = fuzzyMatch("Handcrafted Wooden Duck", "Handcxafted WOODEN");
		expect(m?.tier).toBe("corrected");
		expect(m?.corrected).toBe("Handcrafted WOODEN");
	});

	it("a literal match always outranks a corrected phrase", () => {
		const search = createFuzzySearch([
			"Handcrafted Wooden Duck",
			"Handcxafted Wooden Sign",
			...FILLER,
		]);
		const results = search("handcxafted wooden");
		expect(results[0].item).toBe("Handcxafted Wooden Sign");
		expect(results[0].score).toBeLessThanOrEqual(SCORES.CONTAINS);
		expect(results[1].item).toBe("Handcrafted Wooden Duck");
		expect(results[1].fields[0]?.tier).toBe("corrected");
	});

	it("search() surfaces the phrase correction through the collection gates", () => {
		const search = createFuzzySearch(["Handcrafted Wooden Duck", ...FILLER]);
		const results = search("handcxafted wooden");
		expect(results).toHaveLength(1);
		expect(results[0].item).toBe("Handcrafted Wooden Duck");
		expect(results[0].fields[0]?.tier).toBe("corrected");
	});
});

import { describe, expect, it } from "vitest";
import { normalizeText, splitWords } from "../src/index";

const cases: Array<[string, string]> = [
	["HELLO", "hello"],
	["Café", "cafe"],
	["Über", "uber"],
	["jalapeño", "jalapeno"],
	// ł has no NFD decomposition — exercises the dedicated replace
	["Łódź", "lodz"],
	["Zażółć gęślą jaźń", "zazolc gesla jazn"],
	["  padded  ", "padded"],
	["MiXeD CaSe", "mixed case"],
	["", ""],
];

describe("normalizeText", () => {
	it.each(cases)("normalizes %j to %j", (input, expected) => {
		expect(normalizeText(input)).toBe(expected);
	});

	it("does not touch punctuation", () => {
		// If the punctuation-boundary bug is fixed by normalizing punctuation to
		// spaces rather than by widening boundaryChars, update this pin.
		expect(normalizeText("a.b,c:d;e/f")).toBe("a.b,c:d;e/f");
	});

	it("preserves internal whitespace", () => {
		expect(normalizeText("a  b")).toBe("a  b");
	});

	it("is idempotent", () => {
		for (const [input] of cases) {
			const once = normalizeText(input);
			expect(normalizeText(once)).toBe(once);
		}
	});

	describe("diacritic folding across scripts", () => {
		it.each([
			// French / Portuguese / Scandinavian-adjacent
			["Ça ira déjà", "ca ira deja"],
			["São Tomé", "sao tome"],
			// Vietnamese stacks two marks on one letter; both must strip
			["Trần Hưng Đạo", "tran hung đao"], // đ has no decomposition — stays, like ø
			["Việt Nam", "viet nam"],
			// Czech / Slovak / Romanian
			["Dvořák", "dvorak"],
			["București", "bucuresti"],
			// Greek: tonos strips, final sigma folds to medial
			["ΑΣΠΑΣΊΑ", "ασπασια"],
			["τέλος", "τελοσ"],
			// Cyrillic: ё decomposes to е + diaeresis
			["Всё Хорошо", "все хорошо"],
		])("folds %j to %j", (input, expected) => {
			expect(normalizeText(input)).toBe(expected);
		});

		it("leaves non-decomposable letters alone", () => {
			// ø, đ, ß, ı have no NFD decomposition and no special-case entry;
			// folding them to o/d/ss/i would be a (separate) transliteration
			// decision, not diacritic removal.
			expect(normalizeText("Søren")).toBe("søren");
			expect(normalizeText("straße")).toBe("straße");
			expect(normalizeText("ırmak")).toBe("ırmak");
		});
	});

	describe("offset preservation (1:1 in code units)", () => {
		const oneToOne = (input: string) => {
			const canonical = input.normalize("NFC").trim();
			expect(normalizeText(input)).toHaveLength(canonical.length);
		};

		it("holds for every fold case in this file", () => {
			for (const [input] of cases) oneToOne(input);
		});

		it("absorbs the İ expansion", () => {
			// U+0130 is Unicode's only unconditional one-to-two lowercase
			// mapping; the fold must swallow the combining dot it produces.
			expect(normalizeText("İstanbul")).toBe("istanbul");
			oneToOne("İZMİR İstanbul");
		});

		it("keeps Hangul syllables whole instead of exploding to jamo", () => {
			expect(normalizeText("한국어 검색")).toBe("한국어 검색");
			oneToOne("한국어 검색");
		});

		it("keeps lone combining marks rather than deleting them", () => {
			// q + U+0301 has no precomposed form, so NFC cannot absorb the mark;
			// deleting it would shift every later offset.
			oneToOne("q\u0301x");
		});

		it("keeps astral pairs intact", () => {
			oneToOne("𝔘nicode 😀");
			expect(normalizeText("𐐀𐐀")).toBe("𐐨𐐨"); // Deseret lowercases 1:1 in code points
		});
	});

	describe("canonical equivalence (NFC and NFD inputs agree)", () => {
		it.each([
			["Café", "Café"], // é precomposed vs decomposed
			["Zażółć", "Zażółć"],
			["Việt", "Việt"],
		])("normalises %j and %j identically", (nfc, nfd) => {
			expect(nfc).not.toBe(nfd); // the inputs genuinely differ
			expect(normalizeText(nfd)).toBe(normalizeText(nfc));
		});
	});

	describe("whitespace", () => {
		it("trims tabs and newlines like spaces", () => {
			expect(normalizeText("\thello\n")).toBe("hello");
			expect(normalizeText(" \t ")).toBe("");
		});

		it("trims non-ASCII strings the same way", () => {
			// The trim happens on the slow path too, not just the ASCII shortcut.
			expect(normalizeText("  Café  ")).toBe("cafe");
		});
	});

	describe("fold cache stability", () => {
		it("returns identical results on repeated calls", () => {
			// First call fills the per-code-point cache (dense table below
			// U+0500, Map above); the cached path must agree with the computed
			// path for representatives of both.
			for (const s of ["Łódź", "τέλος", "Всё", "한국어", "𝔘"]) {
				const first = normalizeText(s);
				expect(normalizeText(s)).toBe(first);
				expect(normalizeText(s)).toBe(first);
			}
		});
	});
});

describe("splitWords", () => {
	it.each([
		["hello world", ["hello", "world"]],
		["build, not the runtime", ["build", "not", "the", "runtime"]],
		["a.b,c:d;e/f", ["a", "b", "c", "d", "e", "f"]],
		["foo_bar", ["foo_bar"]], // underscore is kept (snake_case stays whole)
		["", []],
		["   ", []],
	] as const)("splits %j into %j", (input, expected) => {
		expect(splitWords(input)).toEqual(expected);
	});
});

/**
 * The ranges coordinate-space contract: offsets index into `NFC(text).trim()`,
 * which is the caller's own string whenever it is NFC-normal and untrimmed —
 * i.e. virtually all real data. Every tier reports the same space.
 */
import { describe, expect, it } from "vitest";
import { createFuzzySearch, fuzzyMatch, normalizeText } from "../src/index";

describe("ranges index the caller's string", () => {
	describe("leading whitespace", () => {
		it("shifts prefix ranges past the padding", () => {
			const result = fuzzyMatch("  hello", "he");
			expect(result?.tier).toBe("prefix");
			expect(result?.ranges).toEqual([[2, 3]]);
		});

		it("shifts boundary ranges past the padding", () => {
			const result = fuzzyMatch(" Hello World", "wor");
			expect(result?.tier).toBe("boundary");
			expect(result?.ranges).toEqual([[7, 9]]);
		});

		it("shifts collection-path ranges too", () => {
			const results = createFuzzySearch(["  banana"])("ban");
			expect(results[0]?.fields[0]?.ranges).toEqual([[2, 4]]);
		});

		it("treats padding as insignificant for the exact tier", () => {
			// Content-identical modulo padding = exact; range spans the trimmed
			// content's position in the raw string.
			const result = fuzzyMatch("hello", " hello ");
			expect(result?.tier).toBe("exact");
			expect(result?.ranges).toEqual([[0, 4]]);
		});
	});

	describe("length-changing normalization stays 1:1", () => {
		it("İ folds to one unit, offsets aligned", () => {
			// U+0130 is the only unconditional 1→2 lowercase expansion; the fold
			// must absorb it so every later offset stays aligned.
			expect(normalizeText("İstanbul")).toBe("istanbul");
			const result = fuzzyMatch("İstanbul Airport", "airport");
			expect(result?.tier).toBe("boundary");
			expect(result?.ranges).toEqual([[9, 15]]);
		});

		it("Hangul stays syllable-level, not jamo-level", () => {
			// NFD would explode 한국 into 6 jamo units and every offset after it
			// would drift; the 1:1 fold keeps syllables whole.
			expect(normalizeText("한국").length).toBe(2);
			const result = fuzzyMatch("한국어 검색", "한국");
			expect(result?.tier).toBe("prefix");
			expect(result?.ranges).toEqual([[0, 1]]);
		});

		it("Greek sigma folds case-insensitively in both forms", () => {
			// Final sigma (ς) and medial sigma (σ) both fold to σ, so a typed
			// query matches uppercase text regardless of which form it uses.
			expect(fuzzyMatch("ΤΕΛΟΣ", "τελος")?.tier).toBe("normalized-exact");
			expect(fuzzyMatch("ΤΕΛΟΣ", "τελοσ")?.tier).toBe("normalized-exact");
		});
	});

	describe("documented residual: decomposed (NFD) input", () => {
		it("reports offsets into the NFC form", () => {
			// Raw is "Café Marly" (11 units); offsets index NFC's
			// "Café Marly" (10 units). Renders identically; callers holding raw
			// NFD strings (macOS file APIs) should NFC-normalise for display.
			const result = fuzzyMatch("Café Marly", "marly");
			expect(result?.tier).toBe("boundary");
			expect(result?.ranges).toEqual([[5, 9]]);
		});

		it("still matches its precomposed twin", () => {
			expect(fuzzyMatch("Café", "café")?.tier).toBe("normalized-exact");
		});
	});
});

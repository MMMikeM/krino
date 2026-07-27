// Imports internals rather than the public surface: `rawCharMask` is the index
// build's whole per-item cost and its correctness is not observable through
// `createFuzzySearch` — a dropped bit makes results vanish silently.
import { describe, expect, it } from "vitest";
import { charMask } from "../src/gates";
import { normalizeText, rawCharMask } from "../src/normalize";

// Skipping NFC and the trim may only ADD bits. A bit the normalized form sets
// and the raw form does not is a gate that false-rejects, which is the one
// failure no tier can recover from.
const dropped = (raw: string): number => charMask(normalizeText(raw.trim())) & ~rawCharMask(raw);

const CASES: [string, string][] = [
	["lowercase ascii", "generic soft cheese"],
	["mixed case", "Tasty Silk Towels"],
	["digits and punctuation", "SKU-4471/A, rev.2"],
	["leading and trailing whitespace", "   padded value \t\n"],
	["composed diacritics", "café crème brûlée"],
	["decomposed diacritics", "café crème"],
	["no NFD decomposition exists", "Łódź"],
	["final sigma folds to medial", "ΟΔΟΣ ὀδός"],
	["dotted capital I lowercases to two units", "İstanbul"],
	["Hangul stays whole", "한국어 문서"],
	["astral plane", "𝔘nicode 🎉 emoji"],
	["lone combining mark", "́̀ stranded"],
	["typographic quotes", "‘single’ “double”"],
	["cyrillic", "Привет мир"],
	["empty", ""],
	["whitespace only", "   \t  "],
];

describe("rawCharMask never drops a bit charMask would set", () => {
	for (const [name, raw] of CASES) {
		it(name, () => {
			expect(dropped(raw)).toBe(0);
		});
	}

	it("holds over random strings from the interesting code points", () => {
		const pool = [
			..." abcxyzABCXYZ0189-_./",
			..."éèêëàâäùûüôöîïçñ",
			..."ÉÀÇÑŁłŚśŻż",
			..."ΑΒΓΔΟΣσςΩ",
			..."АБВГДЯёй",
			..."한글日本語",
			"́",
			"̀",
			"̈",
			"’",
			"“",
			"𝔘",
			"🎉",
			"\u{1d400}",
		];
		// Deterministic: a fixed LCG, so a failure is reproducible from the seed.
		let seed = 0x2f6e2b1;
		const next = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed;
		};
		for (let n = 0; n < 5000; n++) {
			let raw = "";
			const len = next() % 24;
			for (let k = 0; k < len; k++) raw += pool[next() % pool.length];
			expect({ raw, dropped: dropped(raw) }).toEqual({ raw, dropped: 0 });
		}
	});
});

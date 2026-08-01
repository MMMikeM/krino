// Imports internals: the unfold table is generated data whose only correctness
// property is completeness, and a gap in it makes a gate false-reject silently.
import { describe, expect, it } from "vite-plus/test";
import { normaliseText } from "../src/normalise";
import { unfoldTable } from "../src/unfold";

const UNFOLD = unfoldTable();

describe("the unfold table is the complete inverse of the fold, for ASCII targets", () => {
	it("no BMP code point folds to an ASCII character the table omits", () => {
		const missing: string[] = [];
		for (let cp = 0x20; cp <= 0xffff; cp++) {
			if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates aren't characters
			const ch = String.fromCodePoint(cp);
			const folded = normaliseText(ch);
			if (folded.length !== 1 || !/[a-z0-9]/.test(folded)) continue;
			if (!UNFOLD[folded]?.includes(ch)) {
				missing.push(`U+${cp.toString(16).padStart(4, "0")} -> ${folded}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("every listed source really folds to the character it is listed under", () => {
		const wrong: string[] = [];
		for (const [target, sources] of Object.entries(UNFOLD)) {
			for (const ch of sources) {
				if (normaliseText(ch) !== target) wrong.push(`${ch} listed under ${target}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	it("covers every ASCII letter and digit, so any such query gets a raw gate", () => {
		for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789") {
			expect(UNFOLD[ch]).toContain(ch);
			expect(UNFOLD[ch]).toContain(ch.toUpperCase());
		}
	});
});

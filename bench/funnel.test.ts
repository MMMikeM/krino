/**
 * Gate-funnel diagnostics: for each bench query, how many items each pre-filter
 * stage rejects before the tier ladder runs — mask (O(1) char-class AND), then
 * the regex gate (presence for multi-word, subsequence for single-word),
 * mirroring matchField's order. Prints a table per corpus size; asserts only
 * that the funnel is monotonic and the mask never rejects a true match.
 *
 * Reads krino internals from ../src directly — dist doesn't (and shouldn't)
 * export the gates.
 */
import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "krino";
import { buildFuzzyGate, buildPresenceGate, charMask } from "../src/gates";
import { splitWords } from "../src/boundaries";
import { normalizeText } from "../src/normalize";
import { CORPORA } from "./corpus";

type FunnelRow = {
	query: string;
	items: number;
	"mask cut": string;
	"regex cut": string;
	"ladder entered": number;
	matched: number;
	rescued: number;
};

const pct = (part: number, whole: number): string =>
	whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`;

describe("pre-filter funnel", () => {
	for (const { name, build, queries } of CORPORA)
	for (const size of [10_000, 100_000]) {
		it(`[${name}] stages are monotonic and mask-safe at ${size}`, () => {
			const list = build(size);
			const normalized = list.map(normalizeText);
			const masks = normalized.map(charMask);

			const rows: FunnelRow[] = [];
			for (const query of queries) {
				const normalizedQuery = normalizeText(query);
				const queryMask = charMask(normalizedQuery);
				const gate =
					splitWords(normalizedQuery).length > 1
						? buildPresenceGate(normalizedQuery)
						: buildFuzzyGate(normalizedQuery);

				let maskPass = 0;
				let gatePass = 0;
				let matched = 0;
				let rescued = 0;
				for (let i = 0; i < list.length; i++) {
					const maskOk = (queryMask & masks[i]) === queryMask;
					const result = fuzzyMatch(list[i], query);
					if (result) {
						// The transposition rescue matches a *corrected* query, so
						// its hits legitimately bypass the original query's gates;
						// the mask still holds (a swap preserves the char classes).
						if (result.tier === "transposed") rescued++;
						else matched++;
						// The mask must never reject anything the full matcher accepts.
						expect(maskOk).toBe(true);
					}
					if (!maskOk) continue;
					maskPass++;
					if (!gate.test(normalized[i])) continue;
					gatePass++;
				}

				expect(maskPass).toBeGreaterThanOrEqual(gatePass);
				expect(gatePass).toBeGreaterThanOrEqual(matched);
				rows.push({
					query,
					items: size,
					"mask cut": pct(size - maskPass, size),
					"regex cut": pct(maskPass - gatePass, maskPass),
					"ladder entered": gatePass,
					matched,
					rescued,
				});
			}
			console.table(rows);
		});
	}
});

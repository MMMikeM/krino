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
import { admitsMissingClass } from "../src/match";
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

// Tiers produced by a one-edit rescue: these match a *corrected* query, so they
// legitimately bypass the original query's regex gate.
const RESCUE_TIERS = new Set<string>(["transposed", "inserted", "deleted", "substituted"]);

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

				// Modelling the relaxed gate unconditionally would count items
				// through a filter production never applies, overstating the cut.
				const relaxed = admitsMissingClass(normalizedQuery, splitWords(normalizedQuery));

				let maskPass = 0;
				let gatePass = 0;
				let matched = 0;
				let rescued = 0;
				for (let i = 0; i < list.length; i++) {
					const missingClasses = queryMask & ~masks[i];
					const maskOk = relaxed
						? (missingClasses & (missingClasses - 1)) === 0
						: missingClasses === 0;
					const result = fuzzyMatch(list[i], query);
					if (result) {
						// A one-edit rescue matches a *corrected* query, so its hits
						// legitimately bypass the original query's gates.
						if (RESCUE_TIERS.has(result.tier)) rescued++;
						else matched++;
						// The mask must never reject anything the full matcher accepts.
						expect(maskOk).toBe(true);
						// Only the two edits that can consume a query character may
						// actually be missing a class: a substitution (the wrong
						// character was typed) or a drop (an extra character the
						// field never had). A swap preserves the multiset and a
						// dropped keystroke only shrinks it, so those still need
						// every class present.
						if (missingClasses !== 0) {
							expect(["substituted", "inserted"]).toContain(result.tier);
						}
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

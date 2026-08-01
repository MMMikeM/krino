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
import { describe, expect, it } from "vite-plus/test";
import { fuzzyMatch } from "krino";
import { buildFuzzyGate, buildPresenceGate, buildRescueBigramGate, charMask } from "../src/gates";
import { admitsMissingClass } from "../src/rescue";
import { splitWords } from "../src/boundaries";
import { normaliseText, rawFieldScan } from "../src/normalise";
import { CORPORA } from "./corpus";

type FunnelRow = {
	query: string;
	items: number;
	"mask cut": string;
	"bigram cut": string;
	"regex cut": string;
	"ladder entered": number;
	matched: number;
	rescued: number;
};

const pct = (part: number, whole: number): string =>
	whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`;

// One tier covers every one-edit correction, so the edit itself is derived from
// the corrected query rather than read off a label. The mask invariant below is
// about which edit fired, and this is what keeps it assertable.
const editKind = (query: string, corrected: string): string => {
	const q = normaliseText(query);
	const c = normaliseText(corrected);
	if (c.length === q.length - 1) return "inserted";
	if (c.length === q.length + 1) return "deleted";
	if (c.length !== q.length) return "unknown";
	const diff: number[] = [];
	for (let k = 0; k < q.length; k++) if (q[k] !== c[k]) diff.push(k);
	if (diff.length === 1) return "substituted";
	const swapped =
		diff.length === 2 &&
		diff[1] === diff[0] + 1 &&
		q[diff[0]] === c[diff[1]] &&
		q[diff[1]] === c[diff[0]];
	return swapped ? "transposed" : "unknown";
};

describe("pre-filter funnel", () => {
	for (const { name, build, queries } of CORPORA)
		for (const size of [10_000, 100_000]) {
			it(`[${name}] stages are monotonic and mask-safe at ${size}`, { timeout: 120_000 }, () => {
				const list = build(size);
				const normalised = list.map(normaliseText);
				const masks = normalised.map(charMask);
				const bigrams = list.map((item) => {
					const acc = { lo: 0, hi: 0 };
					rawFieldScan(item, acc);
					return acc;
				});

				const rows: FunnelRow[] = [];
				for (const query of queries) {
					const normalisedQuery = normaliseText(query);
					const queryMask = charMask(normalisedQuery);
					const gate =
						splitWords(normalisedQuery).length > 1
							? buildPresenceGate(normalisedQuery)
							: buildFuzzyGate(normalisedQuery);

					// Modelling the relaxed gate unconditionally would count items
					// through a filter production never applies, overstating the cut.
					const relaxed = admitsMissingClass(normalisedQuery, splitWords(normalisedQuery));
					const bigramGate = relaxed ? buildRescueBigramGate(normalisedQuery) : null;

					let maskPass = 0;
					let bigramPass = 0;
					let gatePass = 0;
					let matched = 0;
					let rescued = 0;
					for (let i = 0; i < list.length; i++) {
						const missingClasses = queryMask & ~masks[i];
						const maskOk = relaxed
							? (missingClasses & (missingClasses - 1)) === 0
							: missingClasses === 0;
						// The searcher's rescue-scan bigram stage: a field missing
						// exactly one class is reachable only by an edit at that
						// class's query position, so the query's untouched bigrams
						// must all be present (see buildRescueBigramGate).
						let bigramOk = maskOk;
						if (bigramOk && missingClasses !== 0 && bigramGate !== null) {
							const b = 31 - Math.clz32(missingClasses);
							bigramOk =
								((bigramGate.requiredLo[b] & ~bigrams[i].lo) |
									(bigramGate.requiredHi[b] & ~bigrams[i].hi)) ===
								0;
						}
						const result = fuzzyMatch(list[i], query);
						if (result) {
							// A one-edit rescue matches a *corrected* query, so its hits
							// legitimately bypass the original query's gates.
							if (result.tier === "corrected") rescued++;
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
								expect(["substituted", "inserted"]).toContain(
									editKind(query, result.corrected as string),
								);
								// The bigram stage must never reject a field the rescue
								// would have corrected.
								expect(
									bigramOk,
									`bigram gate rejected a ${result.tier} match for "${query}": ${list[i]}`,
								).toBe(true);
							}
							// The regex gate is a pre-filter, so it may only false-pass.
							// `gatePass >= matched` below is an aggregate and can hold
							// while individual fields are wrongly rejected; this is the
							// per-field form. It is what licenses the gate being
							// tighter than a bare subsequence test — it anchors at an
							// admissible first chunk, and anything the ladder accepts
							// has one. (A rescue matched a corrected query, so it is
							// exempt for the same reason as the mask above.)
							if (result.tier !== "corrected") {
								expect(
									gate.test(normalised[i]),
									`gate rejected a ${result.tier} match for "${query}": ${list[i]}`,
								).toBe(true);
							}
						}
						if (!maskOk) continue;
						maskPass++;
						if (!bigramOk) continue;
						bigramPass++;
						if (!gate.test(normalised[i])) continue;
						gatePass++;
					}

					expect(maskPass).toBeGreaterThanOrEqual(bigramPass);
					expect(bigramPass).toBeGreaterThanOrEqual(gatePass);
					expect(gatePass).toBeGreaterThanOrEqual(matched);
					rows.push({
						query,
						items: size,
						"mask cut": pct(size - maskPass, size),
						"bigram cut": pct(maskPass - bigramPass, maskPass),
						"regex cut": pct(bigramPass - gatePass, bigramPass),
						"ladder entered": gatePass,
						matched,
						rescued,
					});
				}
				console.table(rows);
			});
		}
});

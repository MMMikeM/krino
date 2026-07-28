/**
 * Long-text guard: the per-query tables match short labels in a list; this
 * probes the OTHER workload — one large string (fuzzyMatch over a document).
 * v1's fuzzy tier junk-matched absent words at 5% by 128 chars and ~98% by 16k
 * (the measured S-curve that motivated the density floor); the floor rejects
 * any chunk assembly covering < 18% of its span, and junk chains over long
 * text measured ≤ 0.143 density — so the junk rate must now be ZERO at every
 * length, and this test asserts exactly that as a regression guard.
 *
 * The document is the mixed corpus joined with spaces, sliced to graded
 * lengths. Probes are real corpus words verified absent from the largest
 * slice (no substring anywhere), so any hit would be the fuzzy tier
 * assembling a junk chain. Present-word probes (sampled from inside each
 * slice) must always match — `contains` needs no fuzzy assembly.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fuzzyMatch, normaliseText, splitWords } from "krino";
import { type LongtextRow, ensureRawDir, rawFile } from "./artifact.ts";
import { CORPORA } from "./corpus";

const DOC_LENGTHS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const ABSENT_PROBES = 40;
const PRESENT_PROBES = 20;

let sink = 0;

// Same time-boxed median as hits.test.ts, minus the reset (fuzzyMatch is
// stateless — no cache to bust).
const timeQuery = (run: () => number): number => {
	for (let i = 0; i < 3; i++) sink += run();
	const budget = performance.now() + 100;
	const samples: number[] = [];
	while (performance.now() < budget) {
		const t0 = performance.now();
		sink += run();
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? 0;
};

const isPlainWord = (w: string): boolean => w.length >= 4 && /^[a-z]+$/.test(w);

describe("long-text matching: the density floor keeps junk at zero", () => {
	it("absent words never match; present words always do", { timeout: 60_000 }, () => {
		const mixed = CORPORA.find((c) => c.name === "mixed");
		if (!mixed) throw new Error("mixed corpus missing");
		const items = mixed.build(10_000);
		const fullDoc = items.join(" ");

		// Absent probes: plain words drawn from items far past any slice we use,
		// each verified absent from the LARGEST slice — so it is absent from
		// every smaller slice too, and one probe set serves every row.
		const maxSlice = normaliseText(fullDoc.slice(0, Math.max(...DOC_LENGTHS)));
		const absent: string[] = [];
		const seen = new Set<string>();
		for (const item of items.slice(5000)) {
			for (const w of splitWords(normaliseText(item))) {
				if (absent.length >= ABSENT_PROBES) break;
				if (seen.has(w) || !isPlainWord(w) || maxSlice.includes(w)) continue;
				seen.add(w);
				absent.push(w);
			}
			if (absent.length >= ABSENT_PROBES) break;
		}
		expect(absent.length).toBe(ABSENT_PROBES);

		const rows: LongtextRow[] = [];

		for (const len of DOC_LENGTHS) {
			const doc = fullDoc.slice(0, len);
			const normalisedDoc = normaliseText(doc);

			// Present probes: words from inside this slice.
			const present = [...new Set(splitWords(normalisedDoc).filter(isPlainWord))].slice(0, PRESENT_PROBES);

			let junk = 0;
			for (const w of absent) if (fuzzyMatch(doc, w)) junk++;
			let presentHits = 0;
			for (const w of present) if (fuzzyMatch(doc, w)) presentHits++;

			// The regression guard: v1 junked 5%→98% across these lengths; the
			// density floor must hold the line at zero.
			expect(junk).toBe(0);
			expect(presentHits).toBe(present.length);

			let i = 0;
			const missMs = timeQuery(() => (fuzzyMatch(doc, absent[i++ % ABSENT_PROBES] as string) ? 1 : 0));

			rows.push({
				docChars: len,
				junkRate: junk / ABSENT_PROBES,
				presentHits,
				presentProbes: present.length,
				missMs,
			});
		}
		sink += fullDoc.length;

		ensureRawDir();
		writeFileSync(rawFile("longtext.json"), JSON.stringify({ rows }, null, "\t"));
	});

	// Damerau-Levenshtein ≤ 1, specialised: equal, one substitution, one
	// adjacent swap, or one insertion/deletion.
	const withinOneEdit = (a: string, b: string): boolean => {
		if (a === b) return true;
		const la = a.length;
		const lb = b.length;
		if (Math.abs(la - lb) > 1) return false;
		if (la === lb) {
			const diffs: number[] = [];
			for (let k = 0; k < la && diffs.length <= 2; k++) if (a[k] !== b[k]) diffs.push(k);
			if (diffs.length === 1) return true;
			return (
				diffs.length === 2 &&
				diffs[1] === diffs[0] + 1 &&
				a[diffs[0]] === b[diffs[1]] &&
				a[diffs[1]] === b[diffs[0]]
			);
		}
		const [short, long] = la < lb ? [a, b] : [b, a];
		let k = 0;
		while (k < short.length && short[k] === long[k]) k++;
		return short.slice(k) === long.slice(k + 1);
	};

	it("a mistyped word beside a real one never invents a phrase match", { timeout: 60_000 }, () => {
		const mixed = CORPORA.find((c) => c.name === "mixed");
		if (!mixed) throw new Error("mixed corpus missing");
		const items = mixed.build(10_000);
		const fullDoc = items.join(" ");
		const maxSlice = normaliseText(fullDoc.slice(0, Math.max(...DOC_LENGTHS)));
		const docWords = [...new Set(splitWords(maxSlice))];

		// Mangle words that are absent from every slice; a probe whose mangled
		// form sits within one edit of a real document word is discarded — a
		// rescue THERE would be a legitimate correction, not junk.
		const mangled: string[] = [];
		const seen = new Set<string>();
		for (const item of items.slice(5000)) {
			for (const w of splitWords(normaliseText(item))) {
				if (mangled.length >= 10) break;
				if (seen.has(w) || !isPlainWord(w) || maxSlice.includes(w)) continue;
				seen.add(w);
				const mid = w.length >> 1;
				const m = w.slice(0, mid) + (w[mid] === "q" ? "x" : "q") + w.slice(mid + 1);
				if (maxSlice.includes(m) || docWords.some((d) => withinOneEdit(m, d))) continue;
				mangled.push(m);
			}
			if (mangled.length >= 10) break;
		}
		expect(mangled.length).toBe(10);

		for (const len of DOC_LENGTHS) {
			const doc = fullDoc.slice(0, len);
			const present = [...new Set(splitWords(normaliseText(doc)).filter(isPlainWord))].slice(
				0,
				mangled.length,
			);
			for (const [j, m] of mangled.entries()) {
				const anchor = present[j % present.length];
				expect(
					fuzzyMatch(doc, `${anchor} ${m}`),
					`"${anchor} ${m}" matched a ${len}-char document`,
				).toBeNull();
			}
		}
	});
});

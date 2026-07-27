/**
 * Query-cost attribution: how many items reach each stage, and what each stage
 * owns of a `search()` call. funnel.test.ts counts what the gates reject; this
 * one prices it, and covers the paths funnel.test.ts predates — the raw gate
 * that runs before any index exists, and the mask scan only the rescue forces.
 *
 * Reconstructs each stage by hand against `../src` internals, so a stage can be
 * run in isolation and priced by difference.
 */
import { expect, it } from "vitest";
import { splitWords } from "../src/boundaries";
import { addRawBigramMask, buildRawGate, buildRescueBigramGate, charMask } from "../src/gates";
import { admitsMissingClass, matchField, prepareQuery } from "../src/match";
import { normalizeText, rawCharMask } from "../src/normalize";
import { SCORES } from "../src/scores";
import { createFuzzySearch } from "../src/search";
import { CORPORA } from "./corpus";

const REPS = 10;
const time = (fn: () => void): number => {
	for (let i = 0; i < 3; i++) fn();
	const t = performance.now();
	for (let i = 0; i < REPS; i++) fn();
	return (performance.now() - t) / REPS;
};

it("prices every stage of the query path", { timeout: 600_000 }, () => {
	for (const { name, build, queries } of CORPORA) {
		const list = build(100_000);
		const raw = list.map((s) => s.trim());
		const norm = raw.map(normalizeText);
		const fieldMask = new Int32Array(list.length);
		const bigramLo = new Int32Array(list.length);
		const bigramHi = new Int32Array(list.length);
		const acc = { lo: 0, hi: 0 };
		for (let i = 0; i < list.length; i++) {
			fieldMask[i] = charMask(norm[i]);
			acc.lo = 0;
			acc.hi = 0;
			addRawBigramMask(list[i], acc);
			bigramLo[i] = acc.lo;
			bigramHi[i] = acc.hi;
		}

		const ms = { rawGate: 0, materialise: 0, ladder: 0, full: 0, maskBuild: 0, relaxed: 0 };
		let gateSurvivors = 0;
		let relaxedSurvivors = 0;
		let results = 0;
		let rescuing = 0;
		let sink = 0;
		let counted = 0;

		for (const query of queries) {
			const nq = normalizeText(query);
			if (nq.length < 2) continue;
			const q = prepareQuery(query, nq);
			const gate = splitWords(nq).length > 1 ? null : buildRawGate(nq);
			if (gate === null) continue;
			counted++;

			const survivors: number[] = [];
			for (let i = 0; i < raw.length; i++) if (gate.test(raw[i])) survivors.push(i);
			gateSurvivors += survivors.length;

			ms.rawGate += time(() => {
				for (let i = 0; i < raw.length; i++) if (gate.test(raw[i])) sink++;
			});
			ms.materialise += time(() => {
				for (const i of survivors) sink += charMask(normalizeText(raw[i])).valueOf();
			});
			ms.ladder += time(() => {
				for (const i of survivors) {
					if (matchField(raw[i], norm[i], fieldMask[i], q, false, true, true)) sink++;
				}
			});

			// What the rescue costs when a query needs it: the whole-corpus mask
			// build, then a relaxed scan admitting one missing character class.
			const relax = admitsMissingClass(nq, q.queryWords);
			const search = createFuzzySearch(list);
			const literal = search(query).filter((r) => r.score <= SCORES.CONTAINS).length;
			results += search(query).length;
			if (relax && literal < 10) {
				rescuing++;
				ms.maskBuild += time(() => {
					const a = { lo: 0, hi: 0 };
					for (let i = 0; i < list.length; i++) {
						sink += rawCharMask(list[i]);
						a.lo = 0;
						a.hi = 0;
						addRawBigramMask(list[i], a);
						sink += a.lo;
					}
				});
				const qm = q.queryMask;
				const gate = buildRescueBigramGate(nq);
				const admits = (i: number): boolean => {
					const miss = qm & ~fieldMask[i];
					if (miss & (miss - 1)) return false;
					if (miss === 0) return true;
					const b = 31 - Math.clz32(miss);
					return ((gate.reqLo[b] & ~bigramLo[i]) | (gate.reqHi[b] & ~bigramHi[i])) === 0;
				};
				let n = 0;
				for (let i = 0; i < list.length; i++) if (admits(i)) n++;
				relaxedSurvivors += n;
				ms.relaxed += time(() => {
					for (let i = 0; i < list.length; i++) {
						if (!admits(i)) continue;
						if (matchField(raw[i], norm[i], fieldMask[i], q, false, false)) sink++;
					}
				});
			}
			ms.full += time(() => {
				sink += search(query).length;
			});
		}

		expect(sink).not.toBe(0);
		const n = counted;
		const pct = (x: number): string => `${((100 * x) / (n * 100_000)).toFixed(2)}%`;
		const p = (x: number): string => (x / n).toFixed(3).padStart(7);
		process.stderr.write(
			`\n${name} 100k — mean of ${n} single-word probes (${rescuing} needed the rescue)\n` +
				`  raw gate      100000 in -> ${(gateSurvivors / n).toFixed(0)} out (${pct(gateSurvivors)})  ${p(ms.rawGate)} ms\n` +
				`  materialise   survivors only                       ${p(ms.materialise)} ms\n` +
				`  ladder        -> ${(results / n).toFixed(0)} results                    ${p(ms.ladder)} ms\n` +
				`  search()      total                                ${p(ms.full)} ms\n` +
				(rescuing
					? `  RESCUE ONLY: mask build ${(ms.maskBuild / rescuing).toFixed(3)} ms, relaxed scan admits ${(relaxedSurvivors / rescuing).toFixed(0)} (${((100 * relaxedSurvivors) / (rescuing * 100_000)).toFixed(1)}%) costing ${(ms.relaxed / rescuing).toFixed(3)} ms\n`
					: ""),
		);
	}
});

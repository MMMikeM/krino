/**
 * Match-count + rank validity: the process-cold runner (bench/run.ts) times
 * work but never checks the work produced results. Every query knows the
 * corpus item it was derived from (corpus.ts `source`), so this runs every
 * benched configuration once per corpus and query and records how many items
 * matched and where the source ranked. Ranks are deterministic, so one
 * untimed pass is the whole measurement; MRR@10 falls out of it.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ProbeTable, type ScorecardRow, ensureRawDir, rawFile } from "./artifact.ts";
import { type Probe, configByName, configs } from "./configs.ts";
import { CORPORA } from "./corpus";

const SIZE = 10_000;

type Outcome = { count: number; rank: number | null };

const outcome = ({ count, ranked }: Probe, source: string | null): Outcome => ({
	count,
	rank: source == null || ranked == null ? null : ranked.indexOf(source) + 1 || null,
});

const runOut: Record<string, { scorecard: ScorecardRow[]; tables: ProbeTable[] }> = {};

describe("bench validity: per-library match counts and source rank", () => {
	for (const { name, build, specs } of CORPORA) {
		it(`[${name}] every library matches the plain-word query`, { timeout: 120_000 }, () => {
			const list = build(SIZE);
			const all = configs(list);

			const tables: ProbeTable[] = [];
			const rrs: Record<string, number[]> = {};
			for (const { query, kind, source } of specs) {
				const cells: ProbeTable["cells"] = {};
				for (const config of all) {
					const { count, rank } = outcome(config.probe(query), source);
					cells[config.name] = { count, rank };
					if (source != null) {
						// MRR@10: a rank outside the top 10 is as invisible to a
						// picker as a miss — both score 0.
						(rrs[config.name] ??= []).push(rank && rank <= 10 ? 1 / rank : 0);
					}
				}
				tables.push({ kind, query, source, cells });
			}

			const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
			const scorecard = Object.entries(rrs)
				.map(([library, xs]) => ({ library, mrr: Number(mean(xs).toFixed(2)) }))
				.sort((a, b) => b.mrr - a.mrr);
			console.table(scorecard);

			// Same-process accumulation: the later corpus rewrites the file with
			// both entries.
			runOut[name] = { scorecard, tables };
			ensureRawDir();
			writeFileSync(rawFile("hits.json"), JSON.stringify(runOut, null, "\t"));

			const countFor = (lib: string, query: string, source: string | null): number =>
				outcome(configByName(all, lib).probe(query), source).count;

			// Every benched lib must find something for a plain corpus word —
			// otherwise its cold numbers time a no-op.
			const plainWord = specs[0];
			for (const config of all) {
				expect(
					countFor(config.name, plainWord.query, plainWord.source),
					`${config.name} found nothing for "${plainWord.query}"`,
				).toBeGreaterThan(0);
			}

			const krino = configByName(all, "krino");
			for (const { query, kind, source } of specs) {
				const { count, rank } = outcome(krino.probe(query), source);
				if (kind === "miss") {
					expect(count, `krino matched garbage "${query}"`).toBe(0);
				} else if (kind === "two-words-double-typo") {
					// Two edits in one phrase: the one-edit rescue must refuse
					// rather than guess. The edit-distance engines may match it;
					// krino returning anything here means the multi-word rescue
					// invented a correction.
					expect(count, `krino guessed at the double typo "${query}"`).toBe(0);
				} else if (!kind.startsWith("scatter")) {
					// krino must surface the item each query was derived from.
					// (The scatter kinds are exempt — those probe where chunk
					// assembly legitimately gives up, and that limit is the
					// measurement. Every typo kind, phrases included, is held to
					// the same bar as everything else.)
					expect(rank, `krino lost source of "${query}" (${kind})`).not.toBeNull();
				}
			}

			// Folding configs must find at least as much as their non-folding
			// base on the accent probe (quantifies the README's †).
			const accentProbe = specs.find((s) => s.kind === "accent-stripped");
			if (accentProbe) {
				const { query, source } = accentProbe;
				expect(countFor("krino", query, source)).toBeGreaterThan(0);
				// Cross-library pairs only exist on a full run; `--only=` narrows the
				// set, and a comparison against an absent row would assert nothing.
				const present = new Set(all.map((c) => c.name));
				for (const lib of ["uFuzzy", "fuse.js"]) {
					if (!present.has(lib) || !present.has(`${lib} (all opts)`)) continue;
					expect(
						countFor(`${lib} (all opts)`, query, source),
						`${lib} (all opts) found less than its non-folding base`,
					).toBeGreaterThanOrEqual(countFor(lib, query, source));
				}
			}
		});
	}
});

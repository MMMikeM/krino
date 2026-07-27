/**
 * The searcher must return exactly the items per-item fuzzyMatch accepts —
 * modulo the rescue budget, which legitimately suppresses corrected-tier hits
 * once ten literal hits exist. Any other diff is a searcher gate
 * false-rejecting (the union masks, the survivor cache, or the rescue bigram
 * gate — none of which fuzzyMatch runs). Imports ../src on purpose: the guard
 * covers the source the gates live in.
 */
import { expect, it } from "vitest";
import { SCORES } from "../src/scores";
import { createFuzzySearch, fuzzyMatch } from "../src/index";
import { CORPORA } from "./corpus";

it("searcher agrees with per-item fuzzyMatch on every bench query", { timeout: 600_000 }, () => {
	for (const { name, build, queries } of CORPORA) {
		for (const size of [10_000, 100_000]) {
			const list = build(size);
			const search = createFuzzySearch(list);
			for (const query of queries) {
				const got = new Map<string, number>();
				for (const r of search(query)) {
					got.set(r.item, (got.get(r.item) ?? 0) + 1);
				}
				let literal = 0;
				const missing: string[] = [];
				for (const item of list) {
					const m = fuzzyMatch(item, query);
					if (!m) continue;
					if (m.score <= SCORES.CONTAINS) literal++;
					const n = got.get(item) ?? 0;
					if (n > 0) got.set(item, n - 1);
					else missing.push(`${m.tier}:${item}`);
				}
				const nonRescueMissing = missing.filter((m) => !m.startsWith("corrected:"));
				expect(nonRescueMissing, `[${name}-${size}] "${query}"`).toEqual([]);
				if (literal < 10) {
					expect(missing, `[${name}-${size}] "${query}" (budget not exhausted)`).toEqual([]);
				}
			}
		}
	}
});

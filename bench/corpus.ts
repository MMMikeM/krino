/**
 * Shared bench corpora + queries, loaded from the committed corpus-*.json
 * snapshots (regenerate deliberately via corpus-gen.test.ts — every rank/MRR
 * table derives from these sequences). Freezing the data keeps bench processes
 * fast (no faker generation per run) and immune to faker changing generator
 * output between versions. Two variants:
 * - `ascii` — en locale only, effectively no diacritics.
 * - `mixed` — mostly en with every 7th item from fr/pl generators, landing at
 *   ~5% of items carrying a diacritic (a realistic international dataset;
 *   the fr/pl generators alone measure ~33%, en ~0%).
 * Items are ~97% unique at 10k — faker repeats a few names; duplicates are
 * interchangeable strings, so rank checks use the first occurrence.
 * Every non-miss query records the corpus item it was derived from (`source`),
 * so hits.test.ts can check each library actually surfaces it — and where it
 * ranks. Used by the speed benches (compare.bench.ts), the gate-funnel
 * diagnostics (funnel.test.ts), and the match-count checks (hits.test.ts).
 */
import asciiJson from "./corpus-ascii.json";
import mixedJson from "./corpus-mixed.json";

// The snapshots hold the full 100k sequence; generation was a single reseed
// followed by sequential appends, so a prefix slice equals a smaller build
// (1k ⊂ 10k ⊂ 100k) and the queries derived from a 2k sample hit at any size.
const slicer =
	(data: string[]) =>
	(n: number): string[] => {
		if (n > data.length) throw new Error(`corpus snapshot has ${data.length} items; asked for ${n}`);
		return data.slice(0, n);
	};

const wordsOf = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const everyOther = (w: string): string => [...w].filter((_, k) => k % 2 === 0).join("");
const stripAccents = (s: string): string => s.normalize("NFD").replace(/\p{M}+/gu, "");

export type QuerySpec = {
	query: string;
	kind:
		| "word"
		| "word-2"
		| "two-words"
		| "prefix"
		| "scatter-light"
		| "scatter-medium"
		| "scatter-heavy"
		| "acronym"
		| "accent-stripped"
		| "miss";
	// The corpus item the query was derived from — rank checks look for it.
	source: string | null;
};

// Queries derived from a fixed sample so they actually match: a real word, a
// second word, a two-word phrase, a raw prefix, a scattered subsequence (fuzzy
// tier), and one guaranteed miss (reject path). Corpora with accented items add
// an accent-stripped word (diacritic-folding path).
const deriveQueries = (build: (n: number) => string[]): QuerySpec[] => {
	const sample = build(2000);
	const wordAt = (i: number): string => wordsOf(sample[i])[0] ?? "steel";
	const specs: QuerySpec[] = [
		{ query: wordAt(4).toLowerCase(), kind: "word", source: sample[4] },
		{ query: wordAt(517).toLowerCase(), kind: "word-2", source: sample[517] },
		{
			query: wordsOf(sample[8]).slice(0, 2).join(" ").toLowerCase(),
			kind: "two-words",
			source: sample[8],
		},
		{ query: sample[42].slice(0, 5).toLowerCase(), kind: "prefix", source: sample[42] },
	];
	// Graded scatter probes, all from ONE ≥7-char source word: drop one middle
	// char (light — a realistic sloppy keystroke), drop every third char
	// (medium), keep only every other char (heavy — 1-char fragments, past any
	// sane fuzzy threshold). Where a library stops surfacing the source is its
	// effective fuzzy limit.
	for (let i = 1300; i < sample.length; i++) {
		const scatterWord = wordsOf(sample[i])[0] ?? "";
		if (scatterWord.length >= 7) {
			const mid = Math.floor(scatterWord.length / 2);
			specs.push(
				{
					query: (scatterWord.slice(0, mid) + scatterWord.slice(mid + 1)).toLowerCase(),
					kind: "scatter-light",
					source: sample[i],
				},
				{
					query: [...scatterWord].filter((_, k) => k % 3 !== 2).join("").toLowerCase(),
					kind: "scatter-medium",
					source: sample[i],
				},
				{ query: everyOther(scatterWord).toLowerCase(), kind: "scatter-heavy", source: sample[i] },
			);
			break;
		}
	}
	// Acronym probe: the initials of the first sample item with 3+ words (e.g.
	// "Rath, Streich and Witting" -> "rsaw"). krino's opt-in acronym tier and
	// match-sorter's ACRONYM ranking target initials deliberately; subsequence
	// engines can only hit them as scattered chains.
	const acronymItem = sample.find((item) => wordsOf(item).length >= 3);
	if (acronymItem) {
		specs.push({
			query: wordsOf(acronymItem)
				.map((w) => w[0])
				.join("")
				.toLowerCase(),
			kind: "acronym",
			source: acronymItem,
		});
	}
	const isAccentedWord = (w: string): boolean => w.length >= 4 && stripAccents(w) !== w;
	const accentedItem = sample.find((item) => wordsOf(item).some(isAccentedWord));
	if (accentedItem) {
		const accentedWord = wordsOf(accentedItem).find(isAccentedWord) as string;
		specs.push({
			query: stripAccents(accentedWord).toLowerCase(),
			kind: "accent-stripped",
			source: accentedItem,
		});
	}
	specs.push({ query: "qxzwkv", kind: "miss", source: null });
	return specs;
};

export type Corpus = {
	name: "ascii" | "mixed";
	build: (n: number) => string[];
	specs: QuerySpec[];
	queries: string[];
};

const makeCorpus = (name: Corpus["name"], build: (n: number) => string[]): Corpus => {
	const specs = deriveQueries(build);
	return { name, build, specs, queries: specs.map((s) => s.query) };
};

export const CORPORA: Corpus[] = [
	makeCorpus("ascii", slicer(asciiJson as string[])),
	makeCorpus("mixed", slicer(mixedJson as string[])),
];

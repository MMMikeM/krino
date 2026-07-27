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
		if (n > data.length)
			throw new Error(`corpus snapshot has ${data.length} items; asked for ${n}`);
		return data.slice(0, n);
	};

const wordsOf = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const everyOther = (w: string): string => [...w].filter((_, k) => k % 2 === 0).join("");
const stripAccents = (s: string): string => s.normalize("NFD").replace(/\p{M}+/gu, "");

export type QuerySpec = {
	query: string;
	kind:
		| "long-word"
		| "short-word"
		| "two-words"
		| "two-words-reversed"
		| "two-words-typo"
		| "two-words-typo-second"
		| "two-words-typo-reversed"
		| "two-words-double-typo"
		| "plural-to-singular"
		| "prefix"
		| "infix"
		| "scatter-light"
		| "scatter-medium"
		| "scatter-heavy"
		| "transposition"
		| "insertion"
		| "substitution"
		| "acronym"
		| "accent-stripped"
		| "miss";
	// The corpus item the query was derived from — rank checks look for it.
	source: string | null;
};

// Swap the first adjacent pair of distinct characters at or after the middle.
// Usually breaks the subsequence property (the swapped pair arrives out of
// order), which is the point: transposition is edit-distance territory, not
// subsequence territory.
const transpose = (w: string): string => {
	for (let k = Math.max(1, Math.floor(w.length / 2) - 1); k + 1 < w.length; k++) {
		if (w[k] !== w[k + 1]) return w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2);
	}
	return w;
};

// The other two single-character typos, both of which also break the
// subsequence property: one character too many (a doubled keystroke) and one
// character wrong. Deletion is already covered by `scatter-light`, which drops
// exactly one middle character.
const doubleChar = (w: string): string => {
	const k = Math.floor(w.length / 2);
	return w.slice(0, k) + w[k] + w.slice(k);
};

const substitute = (w: string): string => {
	const k = Math.floor(w.length / 2);
	// A character the word does not contain, so the query's character-class mask
	// genuinely loses one — the case a strict mask gate rejects outright.
	const replacement = w.includes("x") ? "q" : "x";
	return w.slice(0, k) + replacement + w.slice(k + 1);
};

// Queries derived from a fixed sample so they actually match: a real word, a
// second word, a two-word phrase (in order and reversed), a raw prefix, a
// mid-word infix, a scattered subsequence (fuzzy tier), a transposition typo
// (edit-distance path), and one guaranteed miss (reject path). Corpora with
// accented items add an accent-stripped word (diacritic-folding path).
const deriveQueries = (build: (n: number) => string[]): QuerySpec[] => {
	const sample = build(2000);
	const wordAt = (i: number): string => wordsOf(sample[i])[0] ?? "steel";
	const specs: QuerySpec[] = [
		{ query: wordAt(4).toLowerCase(), kind: "long-word", source: sample[4] },
		{ query: wordAt(517).toLowerCase(), kind: "short-word", source: sample[517] },
		{
			query: wordsOf(sample[8]).slice(0, 2).join(" ").toLowerCase(),
			kind: "two-words",
			source: sample[8],
		},
		// Same two words, reversed: substring engines pass the in-order phrase
		// for free; only genuinely tokenized matching survives the reversal.
		{
			query: wordsOf(sample[8]).slice(0, 2).reverse().join(" ").toLowerCase(),
			kind: "two-words-reversed",
			source: sample[8],
		},
		// A typo inside a phrase. Every other typo probe is single-word, and a
		// multi-word query takes a different route entirely: the presence gate
		// rather than the subsequence gate, with the rescue correcting only the
		// word the field is missing (multiWordRescue). Four variations stress
		// the rescue from each side: typo in the first word, typo in the
		// second, typo with the words reversed (the correction must survive
		// order-independence), and both words mistyped — two edits, which the
		// one-edit rescue must refuse rather than guess at.
		{
			query: [substitute(wordsOf(sample[8])[0] ?? "steel"), wordsOf(sample[8])[1] ?? "chair"]
				.join(" ")
				.toLowerCase(),
			kind: "two-words-typo",
			source: sample[8],
		},
		{
			query: [wordsOf(sample[8])[0] ?? "steel", substitute(wordsOf(sample[8])[1] ?? "chair")]
				.join(" ")
				.toLowerCase(),
			kind: "two-words-typo-second",
			source: sample[8],
		},
		{
			query: [wordsOf(sample[8])[1] ?? "chair", substitute(wordsOf(sample[8])[0] ?? "steel")]
				.join(" ")
				.toLowerCase(),
			kind: "two-words-typo-reversed",
			source: sample[8],
		},
		// No source: like the garbage probe, the right answer is nothing, and
		// what an engine returns instead is the diagnostic.
		{
			query: [substitute(wordsOf(sample[8])[0] ?? "steel"), substitute(wordsOf(sample[8])[1] ?? "chair")]
				.join(" ")
				.toLowerCase(),
			kind: "two-words-double-typo",
			source: null,
		},
		{ query: sample[42].slice(0, 5).toLowerCase(), kind: "prefix", source: sample[42] },
	];

	// Infix probe: an interior slice of a long word — never a prefix, so it
	// separates contains-anywhere matching from start-anchored ranking.
	for (let i = 900; i < sample.length; i++) {
		const infixWord = wordsOf(sample[i])[0] ?? "";
		if (infixWord.length >= 8) {
			specs.push({ query: infixWord.slice(2, 7).toLowerCase(), kind: "infix", source: sample[i] });
			break;
		}
	}
	// Graded scatter probes, all from ONE ≥7-char source word: drop one middle
	// char (light — a realistic sloppy keystroke), drop every third char
	// (medium), keep only every other char (heavy — 1-char fragments, past any
	// sane fuzzy threshold). Where a library stops surfacing the source is its
	// effective fuzzy limit.
	// The word must be near-unique in the 10k corpus (≤ 2 items contain it):
	// faker template words ("Generic", "Ergonomic") appear in ~80 items, every
	// engine that matches the word ties across the whole block, and the source's
	// rank inside that tie block is stable-sort corpus order — noise, not
	// ranking. A near-unique source makes rank mean rank on all four typo
	// probes derived from this word.
	const corpus10k = build(10_000).map((item) => item.toLowerCase());
	const isNearUnique = (word: string): boolean => {
		const needle = word.toLowerCase();
		let holders = 0;
		for (const item of corpus10k) {
			if (item.includes(needle) && wordsOf(item).includes(needle) && ++holders > 2) return false;
		}
		return true;
	};
	// A plural typed against a corpus that holds only the singular: one deletion,
	// which is the whole of what the one-edit rescue can reach. Derived, not
	// hardcoded, and the word must be absent in plural form (or the query matches
	// outright and measures nothing) and near-unique by the same argument the
	// scatter probes make — otherwise the source's rank is tie-block order.
	{
		const present = new Set(sample.flatMap((s) => wordsOf(s).map((w) => w.toLowerCase())));
		outer: for (let i = 0; i < sample.length; i++) {
			for (const raw of wordsOf(sample[i])) {
				const word = raw.toLowerCase();
				if (word.length < 5 || word.endsWith("s") || present.has(`${word}s`)) continue;
				if (!isNearUnique(word)) continue;
				specs.push({ query: `${word}s`, kind: "plural-to-singular", source: sample[i] });
				break outer;
			}
		}
	}
	for (let i = 1300; i < sample.length; i++) {
		const scatterWord = wordsOf(sample[i])[0] ?? "";
		if (scatterWord.length >= 7 && isNearUnique(scatterWord)) {
			const mid = Math.floor(scatterWord.length / 2);
			specs.push(
				{
					query: (scatterWord.slice(0, mid) + scatterWord.slice(mid + 1)).toLowerCase(),
					kind: "scatter-light",
					source: sample[i],
				},
				{
					query: [...scatterWord]
						.filter((_, k) => k % 3 !== 2)
						.join("")
						.toLowerCase(),
					kind: "scatter-medium",
					source: sample[i],
				},
				{ query: everyOther(scatterWord).toLowerCase(), kind: "scatter-heavy", source: sample[i] },
				// A different axis: the three edits that break the subsequence
				// property outright, where a pure subsequence engine returns
				// nothing and only edit-distance matching recovers the item.
				// (`scatter-light` above is the fourth edit — one dropped
				// character — which does stay a subsequence.)
				{ query: transpose(scatterWord).toLowerCase(), kind: "transposition", source: sample[i] },
				{ query: doubleChar(scatterWord).toLowerCase(), kind: "insertion", source: sample[i] },
				{ query: substitute(scatterWord).toLowerCase(), kind: "substitution", source: sample[i] },
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

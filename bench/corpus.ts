/**
 * Corpora + queries from the committed corpus-*.json snapshots. Frozen on
 * purpose: every published rank and MRR derives from these exact sequences,
 * and regeneration (corpus-gen.test.ts, GEN_CORPUS=1) changes the probes too.
 * `ascii` is en-locale; `mixed` lands ~5% of items with a diacritic (every
 * 7th item from fr/pl generators). Every non-miss query records its `source`
 * item so hits.test.ts can check each library surfaces it, and where.
 */
import { readFileSync } from "node:fs";

// readFileSync, not JSON module imports: import attributes differ between
// vitest's bundler and plain node (bench/run.ts children).
const loadCorpus = (file: string): string[] =>
	JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as string[];
const asciiJson: string[] = loadCorpus("./corpus-ascii.json");
const mixedJson: string[] = loadCorpus("./corpus-mixed.json");

// Generation was one reseed + sequential appends, so a prefix slice equals a
// smaller build (1k ⊂ 10k ⊂ 100k) and 2k-sample queries hit at any size.
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

// Swaps at/after the middle, breaking the subsequence property on purpose:
// transposition is edit-distance territory, not subsequence territory.
const transpose = (w: string): string => {
	for (let k = Math.max(1, Math.floor(w.length / 2) - 1); k + 1 < w.length; k++) {
		if (w[k] !== w[k + 1]) return w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2);
	}
	return w;
};

// The other subsequence-breaking one-char typos; deletion is covered by
// `scatter-light`.
const doubleChar = (w: string): string => {
	const k = Math.floor(w.length / 2);
	return w.slice(0, k) + w[k] + w.slice(k);
};

const substitute = (w: string): string => {
	const k = Math.floor(w.length / 2);
	// A character the word does not contain, so the query's mask genuinely
	// loses a class.
	const replacement = w.includes("x") ? "q" : "x";
	return w.slice(0, k) + replacement + w.slice(k + 1);
};

// Derived from a fixed sample so every probe (bar the misses) actually matches.
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
		// Substring engines pass the in-order phrase for free; only genuinely
		// tokenised matching survives the reversal.
		{
			query: wordsOf(sample[8]).slice(0, 2).reverse().join(" ").toLowerCase(),
			kind: "two-words-reversed",
			source: sample[8],
		},
		// Phrase typos take a different route entirely (presence gate + per-word
		// rescue): typo in the first word, the second, reversed order, and both
		// words mistyped — two edits, which a one-edit rescue must refuse.
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
		// No source: the right answer is nothing.
		{
			query: [substitute(wordsOf(sample[8])[0] ?? "steel"), substitute(wordsOf(sample[8])[1] ?? "chair")]
				.join(" ")
				.toLowerCase(),
			kind: "two-words-double-typo",
			source: null,
		},
		{ query: sample[42].slice(0, 5).toLowerCase(), kind: "prefix", source: sample[42] },
	];

	// An interior slice, never a prefix: separates contains-anywhere matching
	// from start-anchored ranking.
	for (let i = 900; i < sample.length; i++) {
		const infixWord = wordsOf(sample[i])[0] ?? "";
		if (infixWord.length >= 8) {
			specs.push({ query: infixWord.slice(2, 7).toLowerCase(), kind: "infix", source: sample[i] });
			break;
		}
	}
	// Graded scatter probes from ONE ≥7-char source word; where a library stops
	// surfacing the source is its effective fuzzy limit. The word must be
	// near-unique: faker template words appear in ~80 items, and a source's
	// rank inside such a tie block is stable-sort corpus order — noise. This is
	// what makes rank mean rank on every probe derived from this word.
	const corpus10k = build(10_000).map((item) => item.toLowerCase());
	const isNearUnique = (word: string): boolean => {
		const needle = word.toLowerCase();
		let holders = 0;
		for (const item of corpus10k) {
			if (item.includes(needle) && wordsOf(item).includes(needle) && ++holders > 2) return false;
		}
		return true;
	};
	// A plural against a singular-only corpus: one deletion. The word must be
	// absent in plural form (or the probe measures nothing) and near-unique by
	// the same tie-block argument.
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
				// The three edits that break the subsequence property outright —
				// only edit-distance matching recovers these.
				{ query: transpose(scatterWord).toLowerCase(), kind: "transposition", source: sample[i] },
				{ query: doubleChar(scatterWord).toLowerCase(), kind: "insertion", source: sample[i] },
				{ query: substitute(scatterWord).toLowerCase(), kind: "substitution", source: sample[i] },
			);
			break;
		}
	}
	// Initials of the first 3+-word item ("Rath, Streich and Witting" → "rsaw");
	// subsequence engines can only hit these as scattered chains.
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
	makeCorpus("ascii", slicer(asciiJson)),
	makeCorpus("mixed", slicer(mixedJson)),
];

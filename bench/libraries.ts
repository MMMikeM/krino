// Hand-maintained, not measured: sizes are `esbuild --bundle --minify`
// (tree-shaken to the primary API) piped through gzip, and every `features`
// cell is verified against that library's current source.

export type Features = {
	ranges: "yes" | "opt-in" | "partial" | "no";
	tier: "yes" | "no";
	diacritics: "yes" | "opt-in" | "no";
	multiWord: "yes" | "opt-in" | "no";
	perField: "yes" | "no";
	typos: "yes" | "opt-in" | "partial" | "no";
};

export type LibraryMeta = {
	gzipKB: number;
	deps: number;
	type: string;
	module: "esm" | "cjs" | "dual";
	updated: string | null;
	features: Features;
};

export const META: Record<string, LibraryMeta> = {
	krino: {
		gzipKB: 5.5,
		deps: 0,
		type: "subsequence (tiered)",
		module: "esm",
		updated: null,
		features: {
			ranges: "yes",
			tier: "yes",
			diacritics: "yes",
			multiWord: "yes",
			perField: "yes",
			typos: "partial",
		},
	},
	"@nozbe/microfuzz": {
		gzipKB: 1.7,
		deps: 0,
		type: "subsequence",
		module: "cjs",
		updated: "2023-07-18",
		features: {
			ranges: "yes",
			tier: "no",
			diacritics: "yes",
			multiWord: "yes",
			perField: "yes",
			typos: "no",
		},
	},
	fuzzysort: {
		gzipKB: 3.7,
		deps: 0,
		type: "subsequence",
		module: "cjs",
		updated: "2024-10-14",
		features: {
			ranges: "yes",
			tier: "no",
			diacritics: "yes",
			multiWord: "yes",
			perField: "yes",
			typos: "no",
		},
	},
	"match-sorter": {
		gzipKB: 3.4,
		deps: 2,
		type: "subsequence (tiered)",
		module: "dual",
		updated: "2026-04-15",
		features: {
			ranges: "no",
			tier: "yes",
			diacritics: "yes",
			multiWord: "no",
			perField: "yes",
			typos: "no",
		},
	},
	uFuzzy: {
		gzipKB: 4.1,
		deps: 0,
		type: "subsequence",
		module: "dual",
		updated: "2025-08-22",
		features: {
			ranges: "yes",
			tier: "no",
			diacritics: "opt-in",
			multiWord: "opt-in",
			perField: "no",
			typos: "opt-in",
		},
	},
	fuzzy: {
		gzipKB: 0.8,
		deps: 0,
		type: "substring",
		module: "cjs",
		updated: "2016-10-01",
		features: {
			ranges: "partial",
			tier: "no",
			diacritics: "no",
			multiWord: "no",
			perField: "no",
			typos: "no",
		},
	},
	"fuse.js": {
		gzipKB: 9.3,
		deps: 0,
		type: "typo-tolerant",
		module: "dual",
		updated: "2026-07-13",
		features: {
			ranges: "opt-in",
			tier: "no",
			diacritics: "opt-in",
			multiWord: "opt-in",
			perField: "yes",
			typos: "yes",
		},
	},
	"fast-fuzzy": {
		gzipKB: 11,
		deps: 1,
		type: "typo-tolerant",
		module: "dual",
		updated: "2022-11-05",
		features: {
			ranges: "partial",
			tier: "no",
			diacritics: "no",
			multiWord: "no",
			perField: "yes",
			typos: "yes",
		},
	},
};

// "krino (acronym)" and "<lib> (all opts)" are configurations of a base library
// and share its size, deps and type.
export const baseName = (name: string): string => name.replace(/ \([^)]+\)$/, "");

export const metaFor = (name: string): LibraryMeta | undefined =>
	META[name] ?? META[baseName(name)];

const DISPLAY: Record<string, string> = { krino: "Krino", "fuse.js": "Fuse.js" };

/** Prose spelling of a configuration name, suffix preserved: `fuse.js (all opts)` → `Fuse.js (all opts)`. */
export const displayName = (name: string): string => {
	const base = baseName(name);
	return (DISPLAY[base] ?? base) + name.slice(base.length);
};

/** Size-table order: krino first, then ascending gzip. */
export const bySize = (a: string, b: string): number =>
	Number(b === "krino") - Number(a === "krino") || (META[a]?.gzipKB ?? 0) - (META[b]?.gzipKB ?? 0);

/**
 * Whether a configuration actually does the corpus's task. The accented corpus
 * requires diacritic folding; a row that skips it is timing a different, easier
 * job, so it is omitted from that corpus's table rather than flagged in it.
 */
export const foldsFor = (corpus: string, name: string): boolean => {
	if (corpus !== "mixed") return true;
	const diacritics = metaFor(name)?.features.diacritics;
	return diacritics === "yes" || (diacritics === "opt-in" && name.endsWith(" (all opts)"));
};

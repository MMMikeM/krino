/**
 * Summarize the raw vitest bench output (results.json) into per-corpus
 * comparison tables + comparison.json. Keeps the noisy per-size detail in JSON;
 * the README shows the per-corpus, krino-relative view.
 *
 *   pnpm bench            # regenerates results.json
 *   node report.mjs       # -> comparison.json + printed markdown tables
 *
 * Cells are `rel% (mean ms)`: rel% is time relative to krino (100%, lower =
 * faster). `Mean` aggregates a row: mean ± sd of its relative columns. `Valid`
 * marks whether the configuration actually does the corpus's task (on the
 * mixed corpus: folds diacritics — cross-checked per query by
 * hits.test.ts). Per-cell sd stays in comparison.json. One table per corpus
 * (`ascii`, `mixed` — see corpus.ts). `type` is the class of search —
 * cross-type rows are not apples-to-apples (typo-tolerant libs do more work;
 * substring libs do less).
 */
import { readFileSync, writeFileSync } from "node:fs";

// Static per-lib metadata. Sizes measured uniformly:
//   esbuild --bundle --minify (tree-shaken to the primary API) | gzip
// `features` verified against each lib's current source (see README table):
//   yes = built-in/default, "opt-in", "partial", no. `updated` = last npm publish.
const META = {
	krino: {
		gzipKB: 2.5, deps: 0, type: "subsequence (tiered)", module: "esm", updated: null,
		features: { ranges: "yes", tier: "yes", diacritics: "yes", multiWord: "yes", perField: "yes", typos: "no" },
	},
	"@nozbe/microfuzz": {
		gzipKB: 1.7, deps: 0, type: "subsequence", module: "cjs", updated: "2023-07-18",
		features: { ranges: "yes", tier: "no", diacritics: "yes", multiWord: "yes", perField: "yes", typos: "no" },
	},
	fuzzysort: {
		gzipKB: 3.7, deps: 0, type: "subsequence", module: "cjs", updated: "2024-10-14",
		features: { ranges: "yes", tier: "no", diacritics: "yes", multiWord: "yes", perField: "yes", typos: "no" },
	},
	"match-sorter": {
		gzipKB: 3.4, deps: 2, type: "subsequence (tiered)", module: "dual", updated: "2026-04-15",
		features: { ranges: "no", tier: "yes", diacritics: "yes", multiWord: "no", perField: "yes", typos: "no" },
	},
	uFuzzy: {
		gzipKB: 4.1, deps: 0, type: "subsequence", module: "dual", updated: "2025-08-22",
		features: { ranges: "yes", tier: "no", diacritics: "opt-in", multiWord: "opt-in", perField: "no", typos: "opt-in" },
	},
	fuzzy: {
		gzipKB: 0.8, deps: 0, type: "substring", module: "cjs", updated: "2016-10-01",
		features: { ranges: "partial", tier: "no", diacritics: "no", multiWord: "no", perField: "no", typos: "no" },
	},
	"fuse.js": {
		gzipKB: 9.3, deps: 0, type: "typo-tolerant", module: "dual", updated: "2026-07-13",
		features: { ranges: "opt-in", tier: "no", diacritics: "opt-in", multiWord: "opt-in", perField: "yes", typos: "yes" },
	},
	"fast-fuzzy": {
		gzipKB: 11, deps: 1, type: "typo-tolerant", module: "dual", updated: "2022-11-05",
		features: { ranges: "partial", tier: "no", diacritics: "no", multiWord: "no", perField: "yes", typos: "yes" },
	},
};

// "<lib> (all opts)" / "krino (acronym)" bench lines share the base lib's
// metadata — strip any parenthesized variant suffix for the lookup.
const metaFor = (name) =>
	META[name] ?? META[name.replace(/ \([^)]+\)$/, "")] ?? { gzipKB: null, deps: null, type: "?" };

const raw = JSON.parse(readFileSync(new URL("./results.json", import.meta.url)));

// Collect per-query mean/sd (ms) per corpus, lib, and list size from the
// "[corpus] query N items × Q queries" groups. Q (queries per sample loop)
// normalizes a sample to a single query; sd scales by the same factor.
const perQuery = {}; // corpus -> lib -> size -> { ms, sd }
for (const file of raw.files ?? []) {
	for (const group of file.groups ?? []) {
		const label = group.fullName ?? group.name ?? "";
		const m = label.match(/\[(\w+)\] query (\d+) items × (\d+) queries/);
		if (!m) continue;
		const [, corpus, size, queryCount] = m;
		for (const b of group.benchmarks ?? []) {
			((perQuery[corpus] ??= {})[b.name] ??= {})[size] = {
				ms: b.mean / Number(queryCount),
				sd: b.sd / Number(queryCount),
			};
		}
	}
}

// Group order: krino's class first, then the different-task classes. Within a
// group, sort by size (krino's axis) so peers read as a block, not a speed race.
const GROUP_RANK = { subsequence: 0, "typo-tolerant": 1, substring: 2 };
const groupRank = (type) => GROUP_RANK[type.replace(/ \(.*\)$/, "")] ?? 9;

const summarize = (byLib, corpus) => {
	const sizes = [...new Set(Object.values(byLib).flatMap((s) => Object.keys(s)))].sort(
		(a, b) => Number(a) - Number(b),
	);
	const base = byLib.krino;
	if (!base) throw new Error(`no 'krino' row for corpus '${corpus}' — run \`pnpm bench\` first`);

	const libraries = Object.entries(byLib)
		.map(([name, bySize]) => {
			const meta = metaFor(name);
			const relToKrino = {};
			for (const size of sizes) {
				if (bySize[size] != null && base[size] != null)
					relToKrino[size] = bySize[size].ms / base[size].ms;
			}
			const rels = Object.values(relToKrino);
			const meanRel = rels.reduce((a, b) => a + b, 0) / rels.length;
			const sdRel = Math.sqrt(
				rels.reduce((s, r) => s + (r - meanRel) ** 2, 0) / rels.length,
			);
			// Valid = this configuration does the corpus's task. Accented corpus
			// requires diacritic folding: built-in, or opt-in switched on by the
			// (all opts) row. hits.test.ts verifies the same thing per query.
			const valid =
				corpus !== "mixed" ||
				meta.features?.diacritics === "yes" ||
				(meta.features?.diacritics === "opt-in" && name.endsWith(" (all opts)"));
			return {
				name,
				valid,
				sdRelPct: Math.round(sdRel * 100),
				gzipKB: meta.gzipKB,
				deps: meta.deps,
				type: meta.type,
				module: meta.module,
				updated: meta.updated,
				features: meta.features,
				perQueryMs: Object.fromEntries(sizes.map((s) => [s, bySize[s]?.ms])),
				perQuerySdMs: Object.fromEntries(sizes.map((s) => [s, bySize[s]?.sd])),
				relToKrino,
				meanRelPct: Math.round(meanRel * 100),
			};
		})
		.sort(
			(a, b) =>
				groupRank(a.type) - groupRank(b.type) || a.gzipKB - b.gzipKB || a.name.localeCompare(b.name),
		);
	return { sizes, libraries };
};

const corpora = Object.fromEntries(
	Object.entries(perQuery).map(([corpus, byLib]) => [corpus, summarize(byLib, corpus)]),
);

const out = {
	method: {
		size: "esbuild --bundle --minify (tree-shaken to primary API) | gzip",
		speed:
			"vitest bench, per-query mean ± sd; perf = time relative to krino (100%), lower is faster",
		corpora: {
			ascii: "en faker locale — effectively no diacritics",
			mixed: "mostly en with fr/pl every 7th item — ~5% of items carry a diacritic",
		},
	},
	corpora: Object.fromEntries(Object.entries(corpora).map(([c, v]) => [c, v.libraries])),
};
writeFileSync(new URL("./comparison.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);

// Print the README tables.
const fmtSize = (s) => (Number(s) >= 1000 ? `${Number(s) / 1000}k` : `${s}`);
const fmtMs = (ms) => ms.toFixed(2);

// Library facts — corpus-independent; "(all opts)" rows share their base's
// size/deps/type, so base configs only.
console.log("\n#### Libraries\n");
console.log("| Library | Gzip | Deps | Type |");
console.log("|---|---|---|---|");
for (const [name, m] of Object.entries(META)) {
	const nm = name === "krino" ? "**krino**" : name;
	console.log(`| ${nm} | ~${m.gzipKB} kB | ${m.deps} | ${m.type} |`);
}

for (const [corpusName, { sizes, libraries }] of Object.entries(corpora)) {
	console.log(`\n#### ${corpusName} corpus\n`);
	// Configurations that can't do the corpus's task are omitted, not flagged:
	// a row that skips diacritic folding on the accented corpus is timing a
	// different, easier job, and hits.test.ts already documents the failure
	// (the accent probe). fast-fuzzy and fuzzy have no folding option at all.
	const shown = libraries.filter((l) => l.valid);
	const dropped = libraries.filter((l) => !l.valid).map((l) => l.name);
	const header = ["Library", ...sizes.flatMap((s) => [fmtSize(s), `${fmtSize(s)} rel`]), "Mean"];
	const rows = shown.map((l) => {
		const nm = l.name === "krino" ? "**krino**" : l.name;
		const perf = sizes
			.flatMap((s) => {
				const r = l.relToKrino[String(s)];
				if (r == null) return ["—", "—"];
				const pct = l.name === "krino" ? `**${Math.round(r * 100)}%**` : `${Math.round(r * 100)}%`;
				return [`${fmtMs(l.perQueryMs[String(s)])} ms`, pct];
			})
			.join(" | ");
		const mean = `${l.meanRelPct}% ± ${l.sdRelPct}`;
		return `| ${nm} | ${perf} | ${mean} |`;
	});
	// Corpus-wide row: mean ± sd of per-query ms across the SHOWN configurations
	// at each size — one number for how hard this corpus is at that scale.
	const colMean = (size) => {
		const vals = shown.map((l) => l.perQueryMs[String(size)]).filter((v) => v != null);
		const m = vals.reduce((a, b) => a + b, 0) / vals.length;
		const sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
		return `${fmtMs(m)} ± ${fmtMs(sd)} ms | —`;
	};
	rows.push(`| *all libraries* | ${sizes.map(colMean).join(" | ")} | — |`);
	console.log(`| ${header.join(" | ")} |`);
	console.log(`|${header.map(() => "---").join("|")}|`);
	console.log(rows.join("\n"));
	if (dropped.length) {
		console.log(
			`\nOmitted (can't fold diacritics, so they'd be timing a different task): ${dropped.join(", ")}. The accent probe in hits.test.ts documents the failure.`,
		);
	}
}
console.log(
	"\n(per size: per-query mean ms, then time relative to krino=100%; Mean = mean ± sd of a row's relative columns; lower = faster)",
);

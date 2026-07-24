/**
 * Summarize the raw vitest bench output (results.json) into per-corpus
 * comparison tables + comparison.json. Keeps the noisy per-size detail in JSON;
 * the README shows the per-corpus, krino-relative view.
 *
 *   pnpm bench            # regenerates results.json
 *   node report.mjs       # -> comparison.json + printed markdown tables
 *
 * Cells are `rel% (mean ms)`: rel% is time relative to krino (100%, lower =
 * faster). `Valid`
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
		gzipKB: 2.6, deps: 0, type: "subsequence (tiered)", module: "esm", updated: null,
		features: { ranges: "yes", tier: "yes", diacritics: "yes", multiWord: "yes", perField: "yes", typos: "partial" },
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
// Build cost per library and size, from the "build index (N items)" groups.
// Bench names map to the library names used in the query groups; a config
// variant reuses its base library's build (the constructor is the same).
const BUILD_NAMES = {
	"krino createFuzzySearch": "krino",
	"@nozbe/microfuzz": "@nozbe/microfuzz",
	"fast-fuzzy new Searcher": "fast-fuzzy",
	"fuse.js new Fuse": "fuse.js",
	"fuzzysort prepare (lazy)": "fuzzysort",
};
const buildMs = {}; // lib -> size -> ms
for (const file of raw.files ?? []) {
	for (const group of file.groups ?? []) {
		const label = group.fullName ?? group.name ?? "";
		const qm = label.match(/\[(\w+)\] query (\d+) items × (\d+) queries/);
		if (qm) {
			const [, corpus, size, queryCount] = qm;
			for (const b of group.benchmarks ?? []) {
				((perQuery[corpus] ??= {})[b.name] ??= {})[size] = {
					ms: b.mean / Number(queryCount),
					sd: b.sd / Number(queryCount),
				};
			}
			continue;
		}
		const bm = label.match(/build index \((\d+) items\)/);
		if (!bm) continue;
		for (const b of group.benchmarks ?? []) {
			const lib = BUILD_NAMES[b.name];
			if (lib) (buildMs[lib] ??= {})[bm[1]] = b.mean;
		}
	}
}

// Group order: krino's class first, then the different-task classes. Within a
// group, sort by size (krino's axis) so peers read as a block, not a speed race.
const GROUP_RANK = { subsequence: 0, "typo-tolerant": 1, substring: 2 };
const groupRank = (type) => GROUP_RANK[type.replace(/ \(.*\)$/, "")] ?? 9;

const summarize = (byLib, corpus) => {
	// All measured sizes land in comparison.json; the published table shows only
	// 100k — sub-millisecond 10k cells sit at timer granularity and mostly
	// publish noise.
	const allSizes = [...new Set(Object.values(byLib).flatMap((s) => Object.keys(s)))].sort(
		(a, b) => Number(a) - Number(b),
	);
	const sizes = allSizes.filter((s) => Number(s) >= 100_000);
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
				perQueryMs: Object.fromEntries(allSizes.map((s) => [s, bySize[s]?.ms])),
				perQuerySdMs: Object.fromEntries(allSizes.map((s) => [s, bySize[s]?.sd])),
				indexMs: Object.fromEntries(
					sizes.map((s) => [s, buildMs[name.replace(/ \([^)]+\)$/, "")]?.[s] ?? null]),
				),
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

// Physical-invariant smoke alarm: the acronym configuration runs strictly more
// code per query than base krino, so base measuring slower than acronym by more
// than a tolerance means the run absorbed GC/thermal debt (observed: 2.4x on a
// loaded machine) and must not be published. Exit nonzero so scripts notice.
for (const [corpus, byLib] of Object.entries(perQuery)) {
	for (const size of Object.keys(byLib.krino ?? {})) {
		const base = byLib.krino?.[size]?.ms;
		const acr = byLib["krino (acronym)"]?.[size]?.ms;
		if (base != null && acr != null && base > acr * 1.15) {
			console.error(
				`WARNING: contaminated run — [${corpus}] ${size} items: base krino ${base.toFixed(2)} ms/query > ` +
					`krino (acronym) ${acr.toFixed(2)} ms/query. More code cannot be faster; rerun on a quiet machine.`,
			);
			process.exitCode = 1;
		}
	}
}

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
	const header = [
		"Library",
		...sizes.flatMap((s) => [
			`${fmtSize(s)} index`,
			`${fmtSize(s)} query`,
			`${fmtSize(s)} total`,
			"query rel",
			"total rel",
		]),
	];
	const rows = shown.map((l) => {
		const nm = l.name === "krino" ? "**krino**" : l.name;
		const kr = shown.find((x) => x.name === "krino");
		const perf = sizes
			.flatMap((s) => {
				const r = l.relToKrino[String(s)];
				if (r == null) return ["—", "—", "—", "—", "—"];
				const emph = (v) => (l.name === "krino" ? `**${v}**` : v);
				const idx = l.indexMs[String(s)];
				const query = l.perQueryMs[String(s)];
				// total = index + one query, the cold one-shot cost; a no-index
				// library's preparation already runs inside its query.
				const total = (idx ?? 0) + query;
				const krTotal = (kr.indexMs[String(s)] ?? 0) + kr.perQueryMs[String(s)];
				return [
					idx == null ? "—" : `${fmtMs(idx)} ms`,
					`${fmtMs(query)} ms`,
					`${fmtMs(total)} ms`,
					emph(`${Math.round(r * 100)}%`),
					emph(`${Math.round((total / krTotal) * 100)}%`),
				];
			})
			.join(" | ");
		return `| ${nm} | ${perf} |`;
	});
	// Corpus-wide row: GEOMETRIC means across the SHOWN configurations. The
	// per-library times span three orders of magnitude, so an arithmetic mean
	// is dominated by the slowest library and describes nobody; the geomean is
	// the standard aggregate for multiplicative spreads (and the only valid
	// way to average ratios).
	const geomean = (vals) => Math.exp(vals.reduce((a, v) => a + Math.log(v), 0) / vals.length);
	const aggFor = (size) => {
		const idxVals = shown.map((l) => l.indexMs[String(size)]).filter((v) => v != null);
		const queryVals = shown.map((l) => l.perQueryMs[String(size)]).filter((v) => v != null);
		const totalVals = shown
			.map((l) => (l.perQueryMs[String(size)] == null ? null : (l.indexMs[String(size)] ?? 0) + l.perQueryMs[String(size)]))
			.filter((v) => v != null);
		return { idx: geomean(idxVals), query: geomean(queryVals), total: geomean(totalVals) };
	};
	// The rel cells of the aggregate row are the geomean of each rel column;
	// geomean-of-ratios = ratio-of-geomeans, so this is also geomean-time /
	// krino-time (the reciprocal of the Krino-vs-geomean row).
	const krRow = shown.find((x) => x.name === "krino");
	const colAgg = (size) => {
		const a = aggFor(size);
		const krQuery = krRow.perQueryMs[String(size)];
		const krTotal = (krRow.indexMs[String(size)] ?? 0) + krQuery;
		return (
			`${fmtMs(a.idx)} ms | ${fmtMs(a.query)} ms | ${fmtMs(a.total)} ms | ` +
			`${Math.round((a.query / krQuery) * 100)}% | ${Math.round((a.total / krTotal) * 100)}%`
		);
	};
	rows.push(`| *all libraries (geomean)* | ${sizes.map(colAgg).join(" | ")} |`);
	// The field's geomean as a multiple of Krino, per metric — same direction
	// as every other percentage in the table (Krino = 100%, higher = more
	// expensive than Krino). Covers index, which has no rel column; the
	// query/total cells necessarily repeat the geomean row's rel cells.
	const kr = shown.find((x) => x.name === "krino");
	const colField = (size) => {
		const a = aggFor(size);
		const idx = kr.indexMs[String(size)];
		const query = kr.perQueryMs[String(size)];
		const total = (idx ?? 0) + query;
		const pct = (num, den) => (den == null ? "—" : `${Math.round((num / den) * 100)}%`);
		return `${pct(a.idx, idx)} | ${pct(a.query, query)} | ${pct(a.total, total)} | ${pct(a.query, query)} | ${pct(a.total, total)}`;
	};
	rows.push(`| *geomean vs Krino* | ${sizes.map(colField).join(" | ")} |`);
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
	"\n(index = one-time build cost, — for libraries that keep no index (their preparation runs inside every query; a variant row shares its base build). query = per-query mean ms against a prebuilt searcher. total = index + one query, the cold one-shot cost. rel columns = time relative to krino=100%, lower = faster. The aggregate row is a geometric mean — the per-library spread covers three orders of magnitude, so an arithmetic mean would just describe the slowest library. The geomean vs Krino row restates that field average as a multiple of Krino, per metric (same Krino=100% direction as every other percentage; over 100% = the average library costs more). 10k cells sit at timer granularity and live in comparison.json only.)",
);

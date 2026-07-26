import type { Artifact, ProbeTable } from "./artifact.ts";
import { PUBLISHED_SIZE, indexMsFor } from "./artifact.ts";
import { META, bySize, displayName, foldsFor } from "./libraries.ts";

type Align = "left" | "right";

const mdTable = (header: string[], rows: string[][], align: Align[]): string => {
	const width = header.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
	);
	const pad = (cell: string, i: number): string =>
		align[i] === "right" ? cell.padStart(width[i]) : cell.padEnd(width[i]);
	const line = (cells: string[]): string => `| ${cells.map(pad).join(" | ")} |`;
	const rule = width
		.map((w, i) => (align[i] === "right" ? `${"-".repeat(w + 1)}:` : "-".repeat(w + 2)))
		.join("|");
	return [line(header), `|${rule}|`, ...rows.map(line)].join("\n");
};

const ms = (v: number): string => v.toFixed(2);
const pct = (num: number, den: number): string => `${Math.round((num / den) * 100)}%`;
const sizeLabel = (s: string): string => (Number(s) >= 1000 ? `${Number(s) / 1000}k` : s);

const sizesOf = (byLib: Record<string, Record<string, unknown>>): string[] =>
	[...new Set(Object.values(byLib).flatMap(Object.keys))].sort((a, b) => Number(a) - Number(b));

// Krino leads its own table; the rest are alphabetical, which keeps each
// library's base and (all opts) rows adjacent and orders nothing by result.
// Code-unit order on the lowercased label, not localeCompare: collation folds
// the `@` in `@nozbe/microfuzz` away and moves it out of first place.
const speedOrder = (a: string, b: string): number => {
	const krino = Number(b.startsWith("krino")) - Number(a.startsWith("krino"));
	if (krino !== 0) return krino;
	const [x, y] = [displayName(a).toLowerCase(), displayName(b).toLowerCase()];
	return x < y ? -1 : x > y ? 1 : 0;
};

// Per-library times span three orders of magnitude, so an arithmetic mean would
// only describe the slowest library; the geomean is the standard aggregate for
// multiplicative spreads, and the only valid way to average ratios.
const geomean = (xs: number[]): number =>
	Math.exp(xs.reduce((a, v) => a + Math.log(v), 0) / xs.length);

const BUILD_COLUMNS: Array<[library: string, label: string]> = [
	["krino", "Krino"],
	["@nozbe/microfuzz", "@nozbe/microfuzz"],
	["fast-fuzzy", "fast-fuzzy"],
	["fuse.js", "Fuse.js"],
	["fuzzysort", "fuzzysort (lazy)"],
];

const buildTable = (a: Artifact): string => {
	const columns = BUILD_COLUMNS.filter(([lib]) => a.build[lib]);
	const sizes = sizesOf(a.build);
	const rows = sizes.map((size) => [
		sizeLabel(size),
		...columns.map(([lib]) => {
			const cell = a.build[lib]?.[size];
			return cell == null ? "—" : `${ms(cell)} ms`;
		}),
	]);
	return mdTable(
		["build", ...columns.map(([, label]) => label)],
		rows,
		["left", ...columns.map((): Align => "right")],
	);
};

const librariesTable = (): string =>
	mdTable(
		["Library", "Gzip", "Deps", "Type"],
		Object.keys(META)
			.sort(bySize)
			.map((name) => {
				const m = META[name];
				const label = name === "krino" ? "**Krino**" : displayName(name);
				return [label, `~${m.gzipKB} kB`, String(m.deps), m.type];
			}),
		["left", "left", "left", "left"],
	);

const speedTable = (a: Artifact, corpus: string): string => {
	const byLib = a.speed[corpus];
	if (!byLib) throw new Error(`no speed data for corpus '${corpus}' — run the speed stage first`);
	const sizes = sizesOf(byLib).filter((s) => Number(s) >= PUBLISHED_SIZE);
	const shown = Object.keys(byLib)
		.filter((name) => foldsFor(corpus, name))
		.sort(speedOrder);
	const krino = byLib.krino;
	if (!krino) throw new Error(`no 'krino' row for corpus '${corpus}'`);

	// total = index + one query: the cold one-shot cost. A library that keeps no
	// index has already run its preparation inside the query.
	const totalOf = (lib: string, size: string): number | null => {
		const query = byLib[lib]?.[size]?.ms;
		return query == null ? null : (indexMsFor(a, lib, size) ?? 0) + query;
	};

	const header = [
		"Library",
		...sizes.flatMap((s) => [
			`${sizeLabel(s)} index`,
			`${sizeLabel(s)} query`,
			`${sizeLabel(s)} total`,
			"query rel",
			"total rel",
		]),
	];

	const rows = shown.map((lib) => [
		lib === "krino" ? "**Krino**" : displayName(lib),
		...sizes.flatMap((size) => {
			const query = byLib[lib]?.[size]?.ms;
			const base = krino[size]?.ms;
			if (query == null || base == null) return ["—", "—", "—", "—", "—"];
			const index = indexMsFor(a, lib, size);
			const total = totalOf(lib, size) as number;
			const krinoTotal = totalOf("krino", size) as number;
			const emphasize = (v: string): string => (lib === "krino" ? `**${v}**` : v);
			return [
				index == null ? "—" : `${ms(index)} ms`,
				`${ms(query)} ms`,
				`${ms(total)} ms`,
				emphasize(pct(query, base)),
				emphasize(pct(total, krinoTotal)),
			];
		}),
	]);

	const aggregate = (size: string) => {
		const defined = <T>(xs: Array<T | null | undefined>): T[] => xs.filter((x) => x != null) as T[];
		return {
			index: geomean(defined(shown.map((lib) => indexMsFor(a, lib, size)))),
			query: geomean(defined(shown.map((lib) => byLib[lib]?.[size]?.ms))),
			total: geomean(defined(shown.map((lib) => totalOf(lib, size)))),
		};
	};

	// geomean-of-ratios is the ratio-of-geomeans, so the rel cells are equally
	// the geomean of each rel column and field-geomean ÷ krino.
	rows.push([
		"_all libraries (geomean)_",
		...sizes.flatMap((size) => {
			const agg = aggregate(size);
			return [
				`${ms(agg.index)} ms`,
				`${ms(agg.query)} ms`,
				`${ms(agg.total)} ms`,
				pct(agg.query, krino[size].ms),
				pct(agg.total, totalOf("krino", size) as number),
			];
		}),
	]);
	rows.push([
		"_geomean vs Krino_",
		...sizes.flatMap((size) => {
			const agg = aggregate(size);
			const index = indexMsFor(a, "krino", size);
			const query = krino[size].ms;
			const total = totalOf("krino", size) as number;
			return [
				index == null ? "—" : pct(agg.index, index),
				pct(agg.query, query),
				pct(agg.total, total),
				pct(agg.query, query),
				pct(agg.total, total),
			];
		}),
	]);

	return mdTable(header, rows, ["left", ...header.slice(1).map((): Align => "right")]);
};

export const omittedFrom = (a: Artifact, corpus: string): string[] =>
	Object.keys(a.speed[corpus] ?? {}).filter((name) => !foldsFor(corpus, name));

const scorecardTable = (a: Artifact, corpus: string): string => {
	const rows = a.scorecard.corpora[corpus];
	if (!rows) throw new Error(`no scorecard for corpus '${corpus}' — run the quality stage first`);
	return mdTable(
		["Library", "MRR", "index ms", "query ms", "total ms"],
		rows.map((r) => [
			displayName(r.library),
			r.mrr.toFixed(2),
			r.indexMs ? ms(r.indexMs) : "—",
			ms(r.queryMs),
			ms(r.totalMs),
		]),
		["left", "right", "right", "right", "right"],
	);
};

// The subset the docs show, each library at its defaults. match-sorter and
// fuzzy track the microfuzz row closely enough that including them only costs
// readability; the artifact keeps their cells.
const PROBE_LIBRARIES: Array<{ base: string; opts?: string }> = [
	{ base: "krino", opts: "krino (acronym)" },
	{ base: "@nozbe/microfuzz", opts: "@nozbe/microfuzz (all opts)" },
	{ base: "fast-fuzzy", opts: "fast-fuzzy (all opts)" },
	{ base: "fuse.js", opts: "fuse.js (all opts)" },
	{ base: "fuzzysort" },
	{ base: "uFuzzy", opts: "uFuzzy (all opts)" },
];

// The scorecard's MRR@10 contribution: what a picker showing ten results sees.
// Rank 142 and rank 145 are both "not found", and the difference between them
// is not a row.
const reciprocalRank = (cell: ProbeTable["cells"][string]): number =>
	cell.rank && cell.rank <= 10 ? 1 / cell.rank : 0;

/**
 * Rows for one probe: every library at its base configuration, joined by its
 * opt-in configuration only where the opt-ins moved the source's rank within
 * the top ten. A widened table therefore always means the opt-ins changed
 * whether, or where, a picker would show the item.
 */
const probeRows = (probe: ProbeTable): string[] =>
	PROBE_LIBRARIES.flatMap(({ base, opts }) =>
		opts && reciprocalRank(probe.cells[base]) !== reciprocalRank(probe.cells[opts])
			? [base, opts]
			: [base],
	);

const rankCell = (cell: ProbeTable["cells"][string]): string =>
	cell.count === 0 ? "—" : String(cell.rank ?? "✗");

const probeTable = (probe: ProbeTable): string =>
	mdTable(
		["Library", "rank", "matches", "query ms", "total ms"],
		probeRows(probe).map((lib) => {
			const cell = probe.cells[lib];
			return [
				displayName(lib),
				rankCell(cell),
				String(cell.count),
				ms(cell.queryMs),
				ms(cell.totalMs),
			];
		}),
		["left", "right", "right", "right", "right"],
	);

/**
 * The guaranteed-miss probe has no rank to report, so its table prices the
 * refusal instead: each library's cost for a hopeless query against its own
 * cost for one that matches.
 */
const missTable = (probes: ProbeTable[]): string => {
	const miss = probes.find((p) => p.kind === "miss");
	const reference = probes.find((p) => p.kind === "long-word");
	if (!miss || !reference) throw new Error("probe set is missing the miss or long-word query");
	return mdTable(
		["Library", "matches", "query ms", `vs \`${reference.query}\``],
		probeRows(miss).map((lib) => [
			displayName(lib),
			String(miss.cells[lib].count),
			miss.cells[lib].queryMs.toFixed(3),
			pct(miss.cells[lib].queryMs, reference.cells[lib].queryMs),
		]),
		["left", "right", "right", "right"],
	);
};

const sessionTable = (a: Artifact): string => {
	const session = a.session;
	if (!session) throw new Error("no session data — run the quality stage first");
	return mdTable(
		["Library", ...session.steps.map((s) => `\`${s}\``), "session"],
		session.rows.map((r) => [
			displayName(r.library),
			...r.stepMs.map(ms),
			ms(r.sessionMs),
		]),
		["left", ...session.steps.map((): Align => "right"), "right"],
	);
};

const longtextTable = (a: Artifact): string => {
	const longtext = a.longtext;
	if (!longtext) throw new Error("no long-text data — run the quality stage first");
	return mdTable(
		["doc chars", "junk rate", "present hits", "miss ms"],
		longtext.rows.map((r) => [
			String(r.docChars),
			`${(100 * r.junkRate).toFixed(0)}%`,
			`${r.presentHits}/${r.presentProbes}`,
			r.missMs.toFixed(3),
		]),
		["right", "right", "right", "right"],
	);
};

/** Corpus the per-probe tables are drawn from; the docs say so in prose. */
const PROBE_CORPUS = "mixed";

/** Every injectable region, keyed by the id its marker carries. */
export const regions = (a: Artifact): Record<string, string> => {
	const out: Record<string, string> = {};
	if (Object.keys(a.build).length) out.build = buildTable(a);
	out.libraries = librariesTable();
	for (const corpus of Object.keys(a.speed)) out[`speed-${corpus}`] = speedTable(a, corpus);
	for (const corpus of Object.keys(a.scorecard.corpora)) {
		out[`scorecard-${corpus}`] = scorecardTable(a, corpus);
	}

	const probes = a.probes[PROBE_CORPUS] ?? [];
	const kinds = new Set<string>();
	for (const probe of probes) {
		if (kinds.has(probe.kind)) throw new Error(`duplicate probe kind '${probe.kind}'`);
		kinds.add(probe.kind);
		out[`probe-${probe.kind}`] = probe.kind === "miss" ? missTable(probes) : probeTable(probe);
	}

	if (a.session) out.session = sessionTable(a);
	if (a.longtext) out.longtext = longtextTable(a);
	return out;
};

import type { Artifact, ColdCell, ProbeTable } from "./artifact.ts";
import { PUBLISHED_SIZE } from "./artifact.ts";
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

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Corpus the per-probe tables are drawn from; the docs say so in prose. */
const PROBE_CORPUS = "mixed";
const PROBE_SIZE = "10000";

const cellOf = (a: Artifact, corpus: string, kind: string, size: string, lib: string): ColdCell | undefined =>
	a.coldMatrix[corpus]?.[kind]?.[size]?.[lib];

const probeKinds = (a: Artifact, corpus: string): string[] =>
	Object.keys(a.coldMatrix[corpus] ?? {}).filter((k) => k !== "batch");

/** Mean first-answer cost across every probe kind — the average cold query. */
const meanColdOf = (a: Artifact, corpus: string, size: string, lib: string): number | null => {
	const cells = probeKinds(a, corpus)
		.map((k) => cellOf(a, corpus, k, size, lib)?.queryMs)
		.filter((v): v is number => v != null);
	return cells.length ? mean(cells) : null;
};

/** Mean one-shot (constructor + first answer, summed per child) across every probe kind. */
const meanOneShotOf = (a: Artifact, corpus: string, size: string, lib: string): number | null => {
	const cells = probeKinds(a, corpus)
		.map((k) => cellOf(a, corpus, k, size, lib)?.oneShotMs)
		.filter((v): v is number => v != null);
	return cells.length ? mean(cells) : null;
};

const variantsOf = (a: Artifact, corpus: string): string[] =>
	Object.keys(a.coldMatrix[corpus]?.batch?.[PROBE_SIZE] ?? {});

const BUILD_COLUMNS: Array<[library: string, label: string]> = [
	["krino", "Krino"],
	["@nozbe/microfuzz", "@nozbe/microfuzz"],
	["fast-fuzzy", "fast-fuzzy"],
	["fuse.js", "Fuse.js"],
	["uFuzzy (all opts)", "uFuzzy (all opts)"],
];

// Constructor cost alone, from the batch cells (the constructor is timed in
// every child; the batch cell's median is as good as any). fuzzysort has no
// constructor at all — its prepare-all pass lands in its cold query.
const buildTable = (a: Artifact): string => {
	const sizes = Object.keys(a.coldMatrix[PROBE_CORPUS]?.batch ?? {});
	const columns = BUILD_COLUMNS.filter(([lib]) =>
		sizes.some((s) => cellOf(a, PROBE_CORPUS, "batch", s, lib)),
	);
	const rows = sizes.map((size) => [
		Number(size) >= 1000 ? `${Number(size) / 1000}k` : size,
		...columns.map(([lib]) => {
			const cell = cellOf(a, PROBE_CORPUS, "batch", size, lib);
			return cell == null ? "—" : `${ms(cell.indexMs)} ms`;
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

// The 100k tables: every cell process-cold. The scale table is the one-shot
// ledger (constructor, mean first answer, and their measured sum); the batch
// table is the session ledger (warmup match + twenty probes, one process).
const scaleTable = (a: Artifact, corpus: string): string => {
	const size = String(PUBLISHED_SIZE);
	const shown = variantsOf(a, corpus)
		.filter((name) => foldsFor(corpus, name))
		.sort(speedOrder);
	const krinoBatch = cellOf(a, corpus, "batch", size, "krino");
	if (!krinoBatch) throw new Error(`no krino batch cell for '${corpus}' — run the cold stage first`);

	const krinoOneShot = meanOneShotOf(a, corpus, size, "krino") as number;
	const rows = shown.map((lib) => {
		const batch = cellOf(a, corpus, "batch", size, lib) as ColdCell;
		const cold = meanColdOf(a, corpus, size, lib) as number;
		const oneShot = meanOneShotOf(a, corpus, size, lib) as number;
		const emphasise = (v: string): string => (lib === "krino" ? `**${v}**` : v);
		return [
			lib === "krino" ? "**Krino**" : displayName(lib),
			`${ms(batch.indexMs)} ms`,
			`${ms(cold)} ms`,
			`${ms(oneShot)} ms`,
			emphasise(pct(oneShot, krinoOneShot)),
		];
	});

	const agg = {
		index: geomean(shown.map((l) => (cellOf(a, corpus, "batch", size, l) as ColdCell).indexMs || 0.01)),
		cold: geomean(shown.map((l) => meanColdOf(a, corpus, size, l) as number)),
		oneShot: geomean(shown.map((l) => meanOneShotOf(a, corpus, size, l) as number)),
	};
	// geomean-of-ratios is the ratio-of-geomeans, so the rel cell is equally
	// the geomean of the rel column and field-geomean ÷ krino.
	rows.push([
		"_all libraries (geomean)_",
		`${ms(agg.index)} ms`,
		`${ms(agg.cold)} ms`,
		`${ms(agg.oneShot)} ms`,
		pct(agg.oneShot, krinoOneShot),
	]);

	return mdTable(
		["Library", "index", "cold query", "total", "total rel"],
		rows,
		["left", "right", "right", "right", "right"],
	);
};

const batchTable = (a: Artifact, corpus: string): string => {
	const size = String(PUBLISHED_SIZE);
	const shown = variantsOf(a, corpus)
		.filter((name) => foldsFor(corpus, name))
		.sort(speedOrder);
	const krinoBatch = cellOf(a, corpus, "batch", size, "krino");
	if (!krinoBatch) throw new Error(`no krino batch cell for '${corpus}' — run the cold stage first`);

	const rows = shown.map((lib) => {
		const batch = cellOf(a, corpus, "batch", size, lib) as ColdCell;
		const emphasise = (v: string): string => (lib === "krino" ? `**${v}**` : v);
		return [
			lib === "krino" ? "**Krino**" : displayName(lib),
			`${ms(batch.restMs ?? batch.queryMs)} ms`,
			`${ms(batch.queryMs)} ms`,
			emphasise(pct(batch.queryMs, krinoBatch.queryMs)),
		];
	});

	const agg = {
		rest: geomean(
			shown.map((l) => {
				const c = cellOf(a, corpus, "batch", size, l) as ColdCell;
				return c.restMs ?? c.queryMs;
			}),
		),
		batch: geomean(shown.map((l) => (cellOf(a, corpus, "batch", size, l) as ColdCell).queryMs)),
	};
	rows.push([
		"_all libraries (geomean)_",
		`${ms(agg.rest)} ms`,
		`${ms(agg.batch)} ms`,
		pct(agg.batch, krinoBatch.queryMs),
	]);

	return mdTable(
		["Library", "batch/query", "batch total", "batch rel"],
		rows,
		["left", "right", "right", "right"],
	);
};

export const omittedFrom = (a: Artifact, corpus: string): string[] =>
	variantsOf(a, corpus).filter((name) => !foldsFor(corpus, name));

const scorecardTable = (a: Artifact, corpus: string): string => {
	const rows = a.scorecard.corpora[corpus];
	if (!rows) throw new Error(`no scorecard for corpus '${corpus}' — run the quality stage first`);
	return mdTable(
		["Library", "MRR", "index ms", "cold ms", "batch ms", "batch/query"],
		rows.map((r) => {
			const batch = cellOf(a, corpus, "batch", PROBE_SIZE, r.library);
			const cold = meanColdOf(a, corpus, PROBE_SIZE, r.library);
			return [
				displayName(r.library),
				r.mrr.toFixed(2),
				batch ? ms(batch.indexMs) : "—",
				cold == null ? "—" : ms(cold),
				batch ? ms(batch.queryMs) : "—",
				batch ? ms(batch.restMs ?? batch.queryMs) : "—",
			];
		}),
		["left", "right", "right", "right", "right", "right"],
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

const probeTable = (a: Artifact, probe: ProbeTable, kindIndex: number): string =>
	mdTable(
		["Library", "rank", "matches", "index ms", "cold ms", "total ms", "batch ms"],
		probeRows(probe).map((lib) => {
			const cell = probe.cells[lib];
			const cold = cellOf(a, PROBE_CORPUS, probe.kind, PROBE_SIZE, lib);
			const batch = cellOf(a, PROBE_CORPUS, "batch", PROBE_SIZE, lib)?.perQueryMs?.[kindIndex];
			return [
				displayName(lib),
				rankCell(cell),
				String(cell.count),
				cold ? ms(cold.indexMs) : "—",
				cold ? ms(cold.queryMs) : "—",
				cold ? ms(cold.oneShotMs) : "—",
				batch == null ? "—" : ms(batch),
			];
		}),
		["left", "right", "right", "right", "right", "right", "right"],
	);

/**
 * The guaranteed-miss probe has no rank to report, so its table prices the
 * refusal instead: each library's cold cost for a hopeless query against its
 * own cold cost for one that matches.
 */
const missTable = (a: Artifact, probes: ProbeTable[]): string => {
	const miss = probes.find((p) => p.kind === "miss");
	const reference = probes.find((p) => p.kind === "long-word");
	if (!miss || !reference) throw new Error("probe set is missing the miss or long-word query");
	return mdTable(
		["Library", "matches", "cold ms", `vs \`${reference.query}\``],
		probeRows(miss).map((lib) => {
			const missCold = cellOf(a, PROBE_CORPUS, "miss", PROBE_SIZE, lib);
			const refCold = cellOf(a, PROBE_CORPUS, "long-word", PROBE_SIZE, lib);
			return [
				displayName(lib),
				String(miss.cells[lib].count),
				missCold ? missCold.queryMs.toFixed(3) : "—",
				missCold && refCold ? pct(missCold.queryMs, refCold.queryMs) : "—",
			];
		}),
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

/** Every injectable region, keyed by the id its marker carries. */
export const regions = (a: Artifact): Record<string, string> => {
	const out: Record<string, string> = {};
	if (Object.keys(a.coldMatrix).length) out.build = buildTable(a);
	out.libraries = librariesTable();
	for (const corpus of Object.keys(a.coldMatrix)) {
		out[`speed-${corpus}`] = scaleTable(a, corpus);
		out[`batch-${corpus}`] = batchTable(a, corpus);
	}
	for (const corpus of Object.keys(a.scorecard.corpora)) {
		out[`scorecard-${corpus}`] = scorecardTable(a, corpus);
	}

	const probes = a.probes[PROBE_CORPUS] ?? [];
	const kinds = new Set<string>();
	for (const probe of probes) {
		if (kinds.has(probe.kind)) throw new Error(`duplicate probe kind '${probe.kind}'`);
		kinds.add(probe.kind);
		out[`probe-${probe.kind}`] =
			probe.kind === "miss" ? missTable(a, probes) : probeTable(a, probe, probes.indexOf(probe));
	}

	if (a.session) out.session = sessionTable(a);
	if (a.longtext) out.longtext = longtextTable(a);
	return out;
};

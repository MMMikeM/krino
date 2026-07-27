// Pareto-frontier charts: accuracy (MRR) vs cost, one chart per ledger.
// - pareto-query-*.svg — query ms with the index prebuilt (frontend ledger:
//   the index is built eagerly at load, keystrokes pay query only).
// - pareto-total-*.svg — total ms = index + first (cold) query (backend one-shot ledger).
// All styling is inlined because GitHub strips <style> blocks from SVGs.
import { writeFileSync } from "node:fs";
import type { Artifact } from "../bench/artifact.ts";
import { displayName } from "../bench/libraries.ts";

type Anchor = "start" | "middle" | "end";
type Placement = { a: Anchor; dy: number; dx: number };
type Metric = "query" | "total";

const lab = (a: Anchor, dy: number, dx = 0): Placement => ({ a, dy, dx });

// Hand-tuned so labels don't collide; positions differ per metric because the
// points move. Numbers come from the artifact, never from here.
const PLACEMENT: Record<string, Record<Metric, Placement>> = {
	"krino (acronym)": { query: lab("start", -8), total: lab("start", -8) },
	krino: { query: lab("start", 16), total: lab("end", 16) },
	"fuse.js": { query: lab("middle", -15), total: lab("middle", -15) },
	"fuse.js (all opts)": { query: lab("end", 20, -10), total: lab("middle", 20) },
	"@nozbe/microfuzz": { query: lab("start", 4), total: lab("end", 4) },
	"fast-fuzzy": { query: lab("start", 4), total: lab("end", 4) },
	fuzzysort: { query: lab("start", 4), total: lab("start", 4) },
	fuzzy: { query: lab("start", -10), total: lab("start", -10) },
	"uFuzzy (all opts)": { query: lab("start", -8), total: lab("end", 4, -10) },
	"match-sorter": { query: lab("start", 16), total: lab("start", 16) },
	uFuzzy: { query: lab("start", 10), total: lab("start", 4) },
};

const FALLBACK: Placement = lab("start", 4);

type Point = { name: string; mrr: number; query: number; total: number };

const METRICS: Record<Metric, {
	file: string;
	X0: number;
	X1: number;
	ticks: number[];
	heading: string;
	subtitle: (probes: number) => string;
	axis: string;
	title: string;
	tail: string;
}> = {
	query: {
		file: "pareto-query",
		X0: 0.15,
		X1: 40,
		ticks: [0.2, 0.5, 1, 2, 5, 10, 20],
		heading: "Ranking quality vs. per-query session cost",
		subtitle: (probes) => `MRR over ${probes} probes · mixed 10k corpus · one searcher, all probes once (batch)`,
		axis: "Batch per-query: searcher built once, twenty distinct queries. Log scale, lower is better",
		title: "Fuzzy search libraries: MRR vs per-query cost across a 20-query session",
		tail:
			"Krino owns the accurate end of the frontier; the cheaper points on it are markedly less accurate, and every other configuration, including Fuse.js, is dominated.",
	},
	total: {
		file: "pareto-total",
		X0: 1,
		X1: 120,
		ticks: [1, 2, 5, 10, 20, 50, 100],
		heading: "Ranking quality vs. cold search cost",
		subtitle: (probes) => `MRR over ${probes} probes · mixed 10k corpus · fresh process per search`,
		axis: "Cold one-shot: constructor + first answer, fresh process. Log scale, lower is better",
		title: "Fuzzy search libraries: MRR vs cold one-shot cost",
		tail:
			"The no-index engines own the cheapest cold one-shots; the two Krino configurations share one pooled build cost and differ only in query time, fuzzysort's prepare-all pass lands in its cold query and moves it off this frontier, and Fuse.js is dominated.",
	},
};

const LIGHT = {
	surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781",
	grid: "#e1e0d9", axis: "#c3c2b7", krino: "#2a78d6", frontier: "#1baf7a", dom: "#898781",
};
const DARK = {
	surface: "#1a1a19", ink: "#ffffff", ink2: "#c3c2b7", muted: "#898781",
	grid: "#2c2c2a", axis: "#383835", krino: "#3987e5", frontier: "#199e70", dom: "#8f8d86",
};
type Palette = typeof LIGHT;

const W = 820, H = 524, ML = 66, MR = 30, MT = 62;
const plotW = W - ML - MR, plotH = 372; // plot bottom fixed at y=434
const Y0 = 0.1, Y1 = 0.92;
const lx = Math.log10;
const Y = (mrr: number): number => MT + ((Y1 - mrr) / (Y1 - Y0)) * plotH;
const f = (v: number): number => Number(v.toFixed(1));
const DOT_R = 6.5;
const yTicks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const tnum = 'font-variant-numeric="tabular-nums"';

// Non-dominated set: sweep by cost ascending, keep strict MRR improvements.
const frontierOf = <T extends { mrr: number; ms: number }>(pts: T[]): T[] => {
	const sorted = [...pts].sort((a, b) => a.ms - b.ms || b.mrr - a.mrr);
	const out: T[] = [];
	let best = -1;
	for (const p of sorted) {
		if (p.mrr > best) {
			out.push(p);
			best = p.mrr;
		}
	}
	return out;
};

const render = (C: Palette, metric: Metric, data: Point[], probes: number): string => {
	const M = METRICS[metric];
	const X = (ms: number): number => ML + ((lx(ms) - lx(M.X0)) / (lx(M.X1) - lx(M.X0))) * plotW;
	const pts = data.map((d) => ({
		n: displayName(d.name),
		mrr: d.mrr,
		ms: d[metric],
		x: f(X(d[metric])),
		y: f(Y(d.mrr)),
		l: PLACEMENT[d.name]?.[metric] ?? FALLBACK,
		isKrino: d.name.startsWith("krino"),
	}));
	const front = frontierOf(pts);
	const onFrontier = new Set(front.map((p) => p.n));
	const color = (p: (typeof pts)[number]): string =>
		p.isKrino ? C.krino : onFrontier.has(p.n) ? C.frontier : C.dom;
	const emphasized = (p: (typeof pts)[number]): boolean => p.isKrino || onFrontier.has(p.n);
	const frontierPath = front.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
	const desc =
		`Scatter plot of ${data.length} configurations of eight JavaScript fuzzy search libraries comparing MRR ` +
		`(how highly each ranks the queried item) against ${metric === "query" ? "query milliseconds with indexes prebuilt" : "total milliseconds for one cold search (index build plus the first, cold query)"}, ` +
		`on a log scale, on the mixed 10k corpus over ${probes} probes. ` +
		`The Pareto frontier runs ${front.map((p) => `${p.n} (${p.mrr.toFixed(2)} MRR at ${p.ms.toFixed(2)} ms)`).join(" to ")}. ` +
		M.tail;

	const grid = [
		...M.ticks.map((t) => `<line x1="${f(X(t))}" y1="${MT}" x2="${f(X(t))}" y2="${MT + plotH}" stroke="${C.grid}"/>`),
		...yTicks.map((t) => `<line x1="${ML}" y1="${f(Y(t))}" x2="${ML + plotW}" y2="${f(Y(t))}" stroke="${C.grid}"/>`),
	].join("\n    ");
	const xLabels = M.ticks
		.map((t) => `<text x="${f(X(t))}" y="${MT + plotH + 18}" text-anchor="middle" fill="${C.muted}" font-size="12" ${tnum}>${t}</text>`)
		.join("\n    ");
	const yLabels = yTicks
		.map((t) => `<text x="${ML - 12}" y="${f(Y(t)) + 4}" text-anchor="end" fill="${C.muted}" font-size="12" ${tnum}>${t.toFixed(1)}</text>`)
		.join("\n    ");
	const dots = [...pts]
		.sort((a, b) => a.y - b.y)
		.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="${DOT_R}" fill="${color(p)}" fill-opacity="0.9" stroke="${C.surface}" stroke-width="1.5"/>`)
		.join("\n    ");
	const labels = [...pts]
		.sort((a, b) => a.y + a.l.dy - (b.y + b.l.dy))
		.map((p) => {
			const tx = p.l.a === "middle" ? f(p.x + p.l.dx) : p.l.a === "end" ? f(p.x - DOT_R - 7) : f(p.x + DOT_R + 7);
			const ink = emphasized(p) ? C.ink : C.muted;
			const weight = emphasized(p) ? ' font-weight="600"' : "";
			return `<text x="${tx}" y="${f(p.y + p.l.dy)}" text-anchor="${p.l.a}" fill="${ink}" font-size="12.5"${weight}>${p.n}</text>`;
		})
		.join("\n    ");

	const LY = H - 16;
	const legend = `<g>
    <line x1="66" y1="${LY}" x2="92" y2="${LY}" stroke="${C.frontier}" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/>
    <text x="100" y="${LY + 4}" fill="${C.ink2}" font-size="12.5">Pareto frontier</text>
    <circle cx="222" cy="${LY}" r="${DOT_R}" fill="${C.krino}"/>
    <text x="234" y="${LY + 4}" fill="${C.ink2}" font-size="12.5">krino</text>
    <circle cx="310" cy="${LY}" r="${DOT_R}" fill="${C.frontier}"/>
    <text x="322" y="${LY + 4}" fill="${C.ink2}" font-size="12.5">other Pareto-optimal</text>
    <circle cx="480" cy="${LY}" r="${DOT_R}" fill="${C.dom}"/>
    <text x="492" y="${LY + 4}" fill="${C.ink2}" font-size="12.5">dominated</text>
  </g>`;

	const better = `<g transform="translate(${ML + 12},${MT + 8})">
    <line x1="34" y1="24" x2="4" y2="4" stroke="${C.muted}" stroke-width="1.5" marker-end="url(#arrow)"/>
    <text x="40" y="20" fill="${C.muted}" font-size="12" font-style="italic">faster &amp; more accurate</text>
  </g>`;

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" role="img" aria-labelledby="${M.file}-title ${M.file}-desc">
  <title id="${M.file}-title">${M.title}</title>
  <desc id="${M.file}-desc">${desc}</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="${C.muted}"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.surface}"/>
  <text x="${ML}" y="28" fill="${C.ink}" font-size="18" font-weight="600">${M.heading}</text>
  <text x="${ML}" y="47" fill="${C.ink2}" font-size="13">${M.subtitle(probes)}</text>
  <g>
    ${grid}
  </g>
  <line x1="${ML}" y1="${MT + plotH}" x2="${ML + plotW}" y2="${MT + plotH}" stroke="${C.axis}"/>
  <line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}" stroke="${C.axis}"/>
  <g>
    ${xLabels}
  </g>
  <g>
    ${yLabels}
  </g>
  <text x="${ML + plotW / 2}" y="${MT + plotH + 45}" text-anchor="middle" fill="${C.ink2}" font-size="13">${M.axis}</text>
  <text transform="translate(18,${MT + plotH / 2}) rotate(-90)" text-anchor="middle" fill="${C.ink2}" font-size="13">Rank of queried item: 1st = 1.0, 10th = 0.1</text>
  <path d="${frontierPath}" fill="none" stroke="${C.frontier}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>
  ${better}
  <g>
    ${dots}
  </g>
  <g>
    ${labels}
  </g>
  ${legend}
</svg>
`;
};

/** Both charts draw mixed 10k: MRR from the scorecard, costs from the cold matrix. */
export const renderPareto = (artifact: Artifact): void => {
	const scorecard = artifact.scorecard.corpora.mixed;
	if (!scorecard?.length) throw new Error("no mixed scorecard — run the quality stage first");
	const kinds = Object.keys(artifact.coldMatrix.mixed ?? {}).filter((k) => k !== "batch");
	const data: Point[] = scorecard.map((r) => {
		const batch = artifact.coldMatrix.mixed?.batch?.["10000"]?.[r.library];
		if (!batch) throw new Error(`no batch cell for '${r.library}' — run the cold stage first`);
		const oneShots = kinds.map((k) => artifact.coldMatrix.mixed[k]["10000"][r.library].oneShotMs);
		return {
			name: r.library,
			mrr: r.mrr,
			query: batch.restMs ?? batch.queryMs,
			total: oneShots.reduce((a, b) => a + b, 0) / oneShots.length,
		};
	});
	const probes = artifact.probes.mixed?.length ?? 0;
	for (const metric of Object.keys(METRICS) as Metric[]) {
		const { file } = METRICS[metric];
		writeFileSync(new URL(`./${file}-light.svg`, import.meta.url), render(LIGHT, metric, data, probes));
		writeFileSync(new URL(`./${file}-dark.svg`, import.meta.url), render(DARK, metric, data, probes));
		const front = frontierOf(data.map((d) => ({ n: displayName(d.name), mrr: d.mrr, ms: d[metric] })));
		console.error(`${file}: frontier = ${front.map((p) => p.n).join(" -> ")}`);
	}
};

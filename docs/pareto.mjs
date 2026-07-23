// Pareto-frontier charts: accuracy (MRR) vs cost, one chart per ledger.
// - pareto-query-*.svg — query ms with the index prebuilt (frontend ledger:
//   the index is built eagerly at load, keystrokes pay query only).
// - pareto-total-*.svg — total ms = index + one query (backend one-shot ledger).
// Emits GitHub-safe light/dark SVGs (all styling inlined — GitHub strips
// <style> blocks) for <picture> swaps.
//   node docs/pareto.mjs
// Data: the mixed-corpus Scorecard in docs/benchmarks.md (5-process medians).
// DATA below is hand-pasted from that table — regenerating the scorecard does
// NOT update it. Re-paste the numbers here before redrawing.
import { writeFileSync } from "node:fs";

// Per-point label placement can differ per metric (positions move).
const lab = (a, dy, dx = 0) => ({ a, dy, dx });
const DATA = [
	{ n: "krino (acronym)", mrr: 0.57, query: 0.16, total: 1.52, lab: { query: lab("start", -8), total: lab("start", -8) } },
	{ n: "@nozbe/microfuzz", mrr: 0.54, query: 1.05, total: 5.45, lab: { query: lab("start", 4), total: lab("end", 4) } },
	{ n: "Fuse.js", mrr: 0.54, query: 14.99, total: 15.72, lab: { query: lab("middle", -15), total: lab("middle", -15) } },
	{ n: "Fuse.js (all opts)", mrr: 0.54, query: 15.35, total: 16.05, lab: { query: lab("middle", 20), total: lab("middle", 20) } },
	{ n: "krino", mrr: 0.53, query: 0.14, total: 1.5, lab: { query: lab("start", 16), total: lab("end", 16) } },
	{ n: "fuzzysort", mrr: 0.38, query: 0.18, total: 5.97, lab: { query: lab("start", 4), total: lab("start", 4) } },
	{ n: "fuzzy", mrr: 0.36, query: 2.41, total: 2.41, lab: { query: lab("start", 4), total: lab("start", 4) } },
	{ n: "match-sorter", mrr: 0.23, query: 2.85, total: 2.85, lab: { query: lab("start", -8), total: lab("start", -8) } },
	{ n: "fast-fuzzy", mrr: 0.23, query: 6.68, total: 39.97, lab: { query: lab("start", 4), total: lab("end", 4) } },
	{ n: "uFuzzy (latinize)", mrr: 0.19, query: 0.18, total: 0.74, lab: { query: lab("start", -8), total: lab("start", 4) } },
	{ n: "uFuzzy", mrr: 0.17, query: 0.18, total: 0.18, lab: { query: lab("start", 10), total: lab("start", 4) } },
];

const METRICS = {
	query: {
		file: "pareto-query",
		X0: 0.08,
		X1: 25,
		ticks: [0.1, 0.2, 0.5, 1, 2, 5, 10, 20],
		heading: "Accuracy vs. query speed",
		subtitle: "MRR (accuracy) vs. query ms — index prebuilt at load · log scale · mixed 10k corpus · 13 test queries",
		axis: "query ms — index prebuilt, log scale (lower = faster)",
		title: "Fuzzy search libraries: MRR vs query latency, index prebuilt",
		desc:
			"Scatter plot of eleven configurations of eight JavaScript fuzzy search libraries comparing MRR (accuracy) against query milliseconds with indexes prebuilt, on a log scale, on the mixed 10k corpus. " +
			"The Pareto frontier is all Krino: from krino (0.53 MRR at 0.14 ms) to krino (acronym) (0.57 at 0.16 ms) — every other configuration, including Fuse.js, is dominated on this ledger.",
	},
	total: {
		file: "pareto-total",
		X0: 0.15,
		X1: 60,
		ticks: [0.2, 0.5, 1, 2, 5, 10, 20, 50],
		heading: "Accuracy vs. total one-shot cost",
		subtitle: "MRR (accuracy) vs. total ms (index + one query) · log scale · mixed 10k corpus · 13 test queries",
		axis: "total ms — index + one query, log scale (lower = faster)",
		title: "Fuzzy search libraries: MRR vs total cost (index + one query)",
		desc:
			"Scatter plot of eleven configurations of eight JavaScript fuzzy search libraries comparing MRR (accuracy) against total milliseconds for one cold search (index build plus one query) on a log scale, on the mixed 10k corpus. " +
			"The Pareto frontier runs uFuzzy, uFuzzy (latinize), krino, krino (acronym) — the two krino configurations share one pooled build cost and differ only in query time; fuzzysort's hidden prepare cache moves it off this frontier, and Fuse.js is dominated — krino (acronym) is more accurate and ~10× cheaper.",
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

const W = 820, H = 524, ML = 66, MR = 30, MT = 62;
const plotW = W - ML - MR, plotH = 372; // plot bottom fixed at y=434
const Y0 = 0.1, Y1 = 0.68;
const lx = Math.log10;
const Y = (mrr) => MT + ((Y1 - mrr) / (Y1 - Y0)) * plotH;
const f = (v) => Number(v.toFixed(1));
const DOT_R = 6.5;
const yTicks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
const tnum = 'font-variant-numeric="tabular-nums"';

// Non-dominated set: sweep by cost ascending, keep strict MRR improvements.
const frontierOf = (pts) => {
	const sorted = [...pts].sort((a, b) => a.ms - b.ms || b.mrr - a.mrr);
	const out = [];
	let best = -1;
	for (const p of sorted) {
		if (p.mrr > best) {
			out.push(p);
			best = p.mrr;
		}
	}
	return out;
};

function render(C, M, metric) {
	const X = (ms) => ML + ((lx(ms) - lx(M.X0)) / (lx(M.X1) - lx(M.X0))) * plotW;
	const pts = DATA.map((d) => ({
		...d,
		ms: d[metric],
		x: f(X(d[metric])),
		y: f(Y(d.mrr)),
		l: d.lab[metric],
	}));
	const front = frontierOf(pts);
	const onFrontier = new Set(front.map((p) => p.n));
	const color = (p) => (p.n.startsWith("krino") ? C.krino : onFrontier.has(p.n) ? C.frontier : C.dom);
	const emphasized = (p) => p.n.startsWith("krino") || onFrontier.has(p.n);
	const frontierPath = front.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

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
  <desc id="${M.file}-desc">${M.desc}</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="${C.muted}"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="${C.surface}"/>
  <text x="${ML}" y="28" fill="${C.ink}" font-size="18" font-weight="600">${M.heading}</text>
  <text x="${ML}" y="47" fill="${C.ink2}" font-size="13">${M.subtitle}</text>
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
  <text transform="translate(18,${MT + plotH / 2}) rotate(-90)" text-anchor="middle" fill="${C.ink2}" font-size="13">MRR — mean reciprocal rank (higher = more accurate) →</text>
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
}

for (const [metric, M] of Object.entries(METRICS)) {
	writeFileSync(new URL(`./${M.file}-light.svg`, import.meta.url), render(LIGHT, M, metric));
	writeFileSync(new URL(`./${M.file}-dark.svg`, import.meta.url), render(DARK, M, metric));
	const front = frontierOf(DATA.map((d) => ({ n: d.n, mrr: d.mrr, ms: d[metric] })));
	console.log(`${M.file}: frontier = ${front.map((p) => p.n).join(" -> ")}`);
}

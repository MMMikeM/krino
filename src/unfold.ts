// Every code point that folds to ASCII lives in these ranges; test/unfold.test.ts
// walks the whole BMP and fails if a fold source ever appears outside them.
const SOURCE_RANGES: readonly (readonly [number, number])[] = [
	[0x30, 0x39],
	[0x41, 0x5a],
	[0x61, 0x7a],
	[0xc0, 0x24f],
	[0x1e00, 0x1eff],
	[0x212a, 0x212b],
];

const DIACRITICS = /[\u0300-\u036f]/g;

let table: Record<string, string> | null = null;

/**
 * For each ASCII letter and digit, every code point that `normaliseText` folds
 * to it — so a gate built from a normalised query can run against the caller's
 * own un-normalised strings. A query character outside the table gets no raw
 * gate and takes the mask path: slower, never wrong.
 *
 * Generated on first use rather than shipped (the fold logic already ships;
 * the precomputed inverse was ~1 kB of redundant bytes), and folded in bulk —
 * one `toLowerCase` and one NFD pass over the separator-joined range,
 * mirroring `computeFold`'s rules — because per-character folding measured
 * ~0.7 ms where this is ~0.2. Never per query character: the classes gate the
 * FIELD side, so a class missing any rare source would false-reject a field
 * that carries it. test/unfold.test.ts pins equivalence with `normaliseText`.
 */
export const unfoldTable = (): Record<string, string> => {
	if (table !== null) return table;
	let sources = "";
	for (const [lo, hi] of SOURCE_RANGES) {
		for (let cp = lo; cp <= hi; cp++) sources += String.fromCharCode(cp);
	}
	const joined = sources.split("").join(" ");
	const lowered = joined.toLowerCase();
	const lowers = lowered.split(" ");
	const candidates = lowered.normalize("NFD").replace(DIACRITICS, "").split(" ");
	const t: Record<string, string> = {};
	for (let i = 0; i < sources.length; i++) {
		const lower = lowers[i];
		let candidate = candidates[i];
		if (candidate === "ł") candidate = "l";
		else if (candidate === "ς") candidate = "σ";
		const folded = candidate.length === 1 ? candidate : lower.length === 1 ? lower : sources[i];
		if (folded.length !== 1) continue;
		const c = folded.charCodeAt(0);
		if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) t[folded] = (t[folded] ?? "") + sources[i];
	}
	table = t;
	return t;
};

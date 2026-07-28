// Every code point that folds to ASCII lives in these ranges: ASCII itself,
// Latin-1 Supplement through Latin Extended-B, Latin Extended Additional, and
// the letterlike Kelvin/Angstrom signs. test/unfold.test.ts walks the whole
// BMP and fails if a fold source ever appears outside them.
const SOURCE_RANGES: readonly (readonly [number, number])[] = [
	[0x30, 0x39],
	[0x41, 0x5a],
	[0x61, 0x7a],
	[0xc0, 0x24f],
	[0x1e00, 0x1eff],
	[0x212a, 0x212b],
];

let table: Record<string, string> | null = null;

/**
 * For each ASCII letter and digit, every code point that `normaliseText` folds
 * to it — the inverse of the fold, which cannot be computed forwards.
 *
 * Lets a gate built from a normalised query run against the caller's own
 * un-normalised strings: `e` becomes a class holding `e E é É ế …`, so no
 * normalised copy of the corpus has to exist before the first query can filter.
 *
 * ASCII targets only, and deliberately: that is 554 code points, where every
 * fold target in the BMP would be 1,275 of them. A query carrying anything
 * outside the table gets no raw gate and takes the mask path instead — slower,
 * never wrong.
 *
 * Generated on first use rather than shipped as a literal: the fold logic
 * already ships, so the ~1 kB precomputed inverse was redundant bytes, and the
 * build lands in the first raw-gate construction a session pays for anyway —
 * never at import. Multi-unit folds and identity folds of non-ASCII stay out,
 * matching `buildRawGate`'s null contract.
 *
 * Folds in bulk — one `toLowerCase` and one NFD pass over the whole
 * separator-joined range, mirroring `computeFold`'s per-character rules —
 * because per-character folding measured ~0.7 ms where this is ~0.2. The
 * classes cannot be built per query character: they gate the FIELD side, so a
 * class missing any rare source would false-reject a field that carries it.
 * test/unfold.test.ts pins equivalence with `normaliseText` per code point.
 */
const DIACRITICS = /[\u0300-\u036f]/g;

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

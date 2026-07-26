const diacritics = /[\u0300-\u036f]/g;
const combiningMarks = /[\u0300-\u036f]/;
const nonAscii = /[\u0080-\uffff]/;

/**
 * Per-code-point case/diacritics fold, cached. The output always has the same
 * number of code units as the input — that 1:1 guarantee is what keeps every
 * normalized offset a valid offset into the caller's (NFC, trimmed) string.
 * Folds that would change the length fall back to plain lowercase (Hangul
 * syllables stay whole rather than exploding into jamo), then to the original
 * code point (lone combining marks stay put rather than vanishing).
 */
// Typographic quote forms fold to their ASCII equivalents: keyboards type
// U+0027/U+0022, macOS smart quotes and faker emit the curly forms, and
// without folding, a query in one form can never match a field in the other
// (the char-class mask rejects the pair before any tier runs).
const QUOTE_FOLDS: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"' };

const computeFold = (ch: string): string => {
	const quote = QUOTE_FOLDS[ch];
	if (quote !== undefined) return quote;
	const lower = ch.toLowerCase();
	let candidate = lower.normalize("NFD").replace(diacritics, "");
	// No NFD decomposition exists for ł; final sigma must fold to medial so
	// queries match regardless of which form either side uses.
	if (candidate === "ł") candidate = "l";
	else if (candidate === "ς") candidate = "σ";
	return candidate.length === ch.length ? candidate : lower.length === ch.length ? lower : ch;
};

// Dense-array cache through Latin Extended + Greek + Cyrillic (an indexed load
// beats Map's string hashing ~1.8× on the fold loop); rarer code points fall
// back to a Map. Both fill lazily — at most one computeFold per distinct
// code point for the lifetime of the process.
const TABLE_MAX = 0x4ff;
// The length is intended; fill() keeps the elements packed, where
// Array.from({ length }) measured slower reads.
// oxlint-disable-next-line unicorn/no-new-array
const foldTable: (string | undefined)[] = new Array(TABLE_MAX + 1).fill(undefined);
const foldRare = new Map<string, string>();
const foldChar = (ch: string): string => {
	const cp = ch.codePointAt(0) as number;
	if (cp <= TABLE_MAX) {
		let folded = foldTable[cp];
		if (folded === undefined) foldTable[cp] = folded = computeFold(ch);
		return folded;
	}
	let folded = foldRare.get(ch);
	if (folded === undefined) {
		folded = computeFold(ch);
		foldRare.set(ch, folded);
	}
	return folded;
};

/**
 * Normalizes text for fuzzy comparison:
 * - Lowercase
 * - Remove diacritics (é → e, ü → u)
 * - Handle special characters (ł → l, ñ → n, ς → σ)
 * - Trim whitespace
 *
 * Offset-preserving by construction: the result has exactly one code unit per
 * unit of `NFC(str).trim()`, so match ranges computed against it index the
 * caller's own string whenever that string is NFC-normal and untrimmed (i.e.
 * virtually all real data; decomposed input — macOS file APIs — gets offsets
 * into the visually-identical NFC form).
 *
 * Pure-ASCII strings (the common case) skip the fold entirely — nothing in it
 * can change an ASCII string. Checked after toLowerCase, which can itself
 * surface combining marks (e.g. İ → i̇).
 */
export const normalizeText = (str: string): string => {
	const lower = str.toLowerCase();
	if (!nonAscii.test(lower)) return lower.trim();
	let s = str.trim();
	// Compose decomposed input first so the per-point fold sees "é", not
	// "e" + combining mark; a no-op (and skipped) for NFC-normal strings.
	if (combiningMarks.test(s)) s = s.normalize("NFC");
	let out = "";
	for (const ch of s) out += foldChar(ch);
	return out;
};

/**
 * `charMask(normalizeText(raw))` without building the normalized string.
 *
 * The build scan needs the mask and nothing else, so folding each code point
 * into the bits directly skips an allocation per item — at 100k items that is
 * the whole eager index's cost, for a value most items never have read.
 *
 * Skipping NFC can only ADD bits (a decomposed "é" contributes its combining
 * mark to the non-ASCII bucket where the composed form would not), and extra
 * field bits make the gate more permissive. False-pass only, which is the rule
 * every gate here obeys.
 */
export const rawCharMask = (raw: string): number => {
	let mask = 0;
	for (let i = 0; i < raw.length; i++) {
		const c = raw.charCodeAt(i);
		// ASCII by code unit, allocation-free: iterating with for..of would build
		// a one-character string per code point, ~3M of them over a 100k corpus.
		if (c >= 97 && c <= 122) mask |= 1 << (c - 97);
		else if (c >= 65 && c <= 90) mask |= 1 << (c - 65);
		else if (c >= 48 && c <= 57) mask |= 1 << (26 + (c & 3));
		else if (c > 127) {
			// Only here does the fold matter, and only here does it allocate:
			// "é" contributes the letter bit for "e", not the non-ASCII bucket,
			// so skipping the fold would DROP a bit and false-reject.
			const cp = raw.codePointAt(i) as number;
			if (cp > 0xffff) i++;
			const folded = foldChar(String.fromCodePoint(cp));
			for (let k = 0; k < folded.length; k++) {
				const f = folded.charCodeAt(k);
				if (f >= 97 && f <= 122) mask |= 1 << (f - 97);
				else if (f >= 65 && f <= 90) mask |= 1 << (f - 65);
				else if (f >= 48 && f <= 57) mask |= 1 << (26 + (f & 3));
				else if (f > 127) mask |= 1 << (30 + (f & 1));
			}
		}
	}
	return mask;
};

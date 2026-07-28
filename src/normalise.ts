const diacriticMarks = /[\u0300-\u036f]/g;
const hasCombiningMark = /[\u0300-\u036f]/;
const hasNonAscii = /[\u0080-\uffff]/;

// Keyboards type U+0027/U+0022; macOS smart quotes emit the curly forms, and
// without the fold one form can never match the other.
const QUOTE_FOLDS: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"' };

// One folded string per code point, never changing the code-unit length — the
// 1:1 guarantee behind every published Range. Length-changing folds fall back
// to plain lowercase, then to the original character.
const computeFold = (ch: string): string => {
	const quote = QUOTE_FOLDS[ch];
	if (quote !== undefined) return quote;
	const lowered = ch.toLowerCase();
	let stripped = lowered.normalize("NFD").replace(diacriticMarks, "");
	// ł has no NFD decomposition; final sigma folds to medial.
	if (stripped === "ł") stripped = "l";
	else if (stripped === "ς") stripped = "σ";
	return stripped.length === ch.length ? stripped : lowered.length === ch.length ? lowered : ch;
};

// Dense array through Latin Extended + Greek + Cyrillic (an indexed load beats
// Map's string hashing ~1.8× on the fold loop); rarer code points use the Map.
const DENSE_FOLDS_MAX = 0x4ff;
// fill() keeps the elements packed; Array.from({ length }) reads slower.
// oxlint-disable-next-line unicorn/no-new-array
const denseFolds: (string | undefined)[] = new Array(DENSE_FOLDS_MAX + 1).fill(undefined);
const rareFolds = new Map<string, string>();

export const foldChar = (ch: string): string => {
	const codePoint = ch.codePointAt(0) as number;
	if (codePoint <= DENSE_FOLDS_MAX) {
		let folded = denseFolds[codePoint];
		if (folded === undefined) denseFolds[codePoint] = folded = computeFold(ch);
		return folded;
	}
	let folded = rareFolds.get(ch);
	if (folded === undefined) {
		folded = computeFold(ch);
		rareFolds.set(ch, folded);
	}
	return folded;
};

/**
 * Normalises text for fuzzy comparison:
 * - Lowercase
 * - Remove diacritics (é → e, ü → u)
 * - Handle special characters (ł → l, ñ → n, ς → σ)
 * - Trim whitespace
 *
 * Offset-preserving by construction: the result has exactly one code unit per
 * unit of `NFC(str).trim()`, so match ranges computed against it index the
 * caller's own string whenever that string is NFC-normal and untrimmed
 * (virtually all real data; decomposed input gets offsets into the
 * visually-identical NFC form).
 */
export const normaliseText = (str: string): string => {
	// toLowerCase can itself surface combining marks (İ → i̇), so the pure-ASCII
	// fast path tests after it.
	const lowered = str.toLowerCase();
	if (!hasNonAscii.test(lowered)) return lowered.trim();
	let text = str.trim();
	// Compose first so the per-point fold sees "é", not "e" + combining mark.
	if (hasCombiningMark.test(text)) text = text.normalize("NFC");
	let folded = "";
	for (const ch of text) folded += foldChar(ch);
	return folded;
};

// `charMask`'s class for one folded code unit, shifted so 0 can mean "not a
// word character": class n sets mask bit n − 1, for every class. Buckets
// collide exactly where charMask's do, so a collision can only weaken the
// bigram filter, never strengthen it.
export const bigramClass = (unit: number): number => {
	if (unit >= 97 && unit <= 122) return unit - 96;
	if (unit >= 65 && unit <= 90) return unit - 64;
	if (unit >= 48 && unit <= 57) return 27 + (unit & 3);
	if (unit > 127) return 31 + (unit & 1);
	return 0;
};

export const bigramBit = (prev: number, cur: number): number => (prev * 37 + cur) & 63;

/**
 * `charMask(normaliseText(raw))` without building the normalised string, plus
 * the field's rescue bigram set filled into `bigrams` — adjacent same-word
 * class pairs and consecutive word-initial pairs, 64 bits in two int32s. Runs
 * once per field, when a searcher meets its first rescue-shaped query.
 *
 * Both halves may only false-pass: skipping NFC can only ADD mask bits, and a
 * combining mark — where raw adjacency stops matching normalised adjacency —
 * degrades the bigram set to all-bits while the mask keeps folding.
 */
export const rawFieldScan = (raw: string, bigrams: { lo: number; hi: number }): number => {
	let mask = 0;
	let pairsLo = 0;
	let pairsHi = 0;
	let prevClass = 0;
	let lastWordInitial = 0;
	let degraded = false;
	// The per-unit body appears twice (raw ASCII unit, folded unit), classifies
	// inline, and writes mask bits per branch: every factored shape — shared
	// helper, closure, module scratch, single mask-write site off
	// `bigramClass − 1` — measured 8–15% slower on the whole-corpus build.
	for (let i = 0; i < raw.length; i++) {
		const unit = raw.charCodeAt(i);
		if (unit < 128) {
			let unitClass = 0;
			if (unit >= 97 && unit <= 122) {
				mask |= 1 << (unit - 97);
				unitClass = unit - 96;
			} else if (unit >= 65 && unit <= 90) {
				mask |= 1 << (unit - 65);
				unitClass = unit - 64;
			} else if (unit >= 48 && unit <= 57) {
				mask |= 1 << (26 + (unit & 3));
				unitClass = 27 + (unit & 3);
			}
			if (unitClass !== 0 && !degraded) {
				if (prevClass !== 0) {
					const bit = (prevClass * 37 + unitClass) & 63;
					if (bit < 32) pairsLo |= 1 << bit;
					else pairsHi |= 1 << (bit - 32);
				} else {
					if (lastWordInitial !== 0) {
						const bit = (lastWordInitial * 37 + unitClass) & 63;
						if (bit < 32) pairsLo |= 1 << bit;
						else pairsHi |= 1 << (bit - 32);
					}
					lastWordInitial = unitClass;
				}
			}
			prevClass = unitClass;
			continue;
		}
		if (unit >= 0x300 && unit <= 0x36f) degraded = true;
		const codePoint = raw.codePointAt(i) as number;
		if (codePoint > 0xffff) i++;
		const folded = foldChar(String.fromCodePoint(codePoint));
		for (let k = 0; k < folded.length; k++) {
			const foldedUnit = folded.charCodeAt(k);
			let unitClass = 0;
			if (foldedUnit >= 97 && foldedUnit <= 122) {
				mask |= 1 << (foldedUnit - 97);
				unitClass = foldedUnit - 96;
			} else if (foldedUnit >= 65 && foldedUnit <= 90) {
				mask |= 1 << (foldedUnit - 65);
				unitClass = foldedUnit - 64;
			} else if (foldedUnit >= 48 && foldedUnit <= 57) {
				mask |= 1 << (26 + (foldedUnit & 3));
				unitClass = 27 + (foldedUnit & 3);
			} else if (foldedUnit > 127) {
				mask |= 1 << (30 + (foldedUnit & 1));
				if (foldedUnit >= 0x300 && foldedUnit <= 0x36f) degraded = true;
				else unitClass = 31 + (foldedUnit & 1);
			}
			if (unitClass !== 0 && !degraded) {
				if (prevClass !== 0) {
					const bit = (prevClass * 37 + unitClass) & 63;
					if (bit < 32) pairsLo |= 1 << bit;
					else pairsHi |= 1 << (bit - 32);
				} else {
					if (lastWordInitial !== 0) {
						const bit = (lastWordInitial * 37 + unitClass) & 63;
						if (bit < 32) pairsLo |= 1 << bit;
						else pairsHi |= 1 << (bit - 32);
					}
					lastWordInitial = unitClass;
				}
			}
			prevClass = unitClass;
		}
	}
	if (degraded) {
		bigrams.lo = -1;
		bigrams.hi = -1;
	} else {
		bigrams.lo |= pairsLo;
		bigrams.hi |= pairsHi;
	}
	return mask;
};

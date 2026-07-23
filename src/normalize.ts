const diacriticsRegex = /[\u0300-\u036f]/g;
const regexŁ = /ł/g;
const regexÑ = /ñ/g;
const nonAscii = /[\u0080-\uffff]/;
// Any run of non-alphanumerics (underscore excepted, so snake_case stays whole)
// separates words. Keeps "build," and "build" the same token.
const wordSeparators = /[^\p{L}\p{N}_]+/u;

/**
 * Normalizes text for fuzzy comparison:
 * - Lowercase
 * - Remove diacritics (é → e, ü → u)
 * - Handle special characters (ł → l, ñ → n)
 * - Trim whitespace
 *
 * Pure-ASCII strings (the common case) skip the NFD decompose and the three
 * regex replaces — none of them can change an ASCII string. Checked after
 * toLowerCase, which can itself surface combining marks (e.g. İ → i̇).
 */
export const normalizeText = (str: string): string => {
	const lower = str.toLowerCase();
	if (!nonAscii.test(lower)) return lower.trim();
	return lower
		.normalize("NFD")
		.replace(diacriticsRegex, "")
		.replace(regexŁ, "l")
		.replace(regexÑ, "n")
		.trim();
};

/**
 * Splits normalized text into words on any punctuation/whitespace run, so
 * multi-word matching tokenizes "build," and "build" identically.
 */
export const splitWords = (text: string): string[] => text.split(wordSeparators).filter(Boolean);

/**
 * The two boundary definitions in play, side by side:
 *
 * - `wordChar` — the tokenization class. Its complement is what `splitWords`
 *   splits on, and the multi-word and acronym tiers follow it.
 * - `boundaryChars` — an enumerated allowlist used by the boundary tiers and
 *   by fuzzy chunk admission/pricing. Deliberately narrower than ¬wordChar:
 *   `?`, `&`, `!` and friends separate words for tokenization but do not count
 *   as boundaries here. Widening it to ¬wordChar would be more principled but
 *   shifts published fuzzy scores — a measured decision, not a drive-by.
 */

// The single source of truth for what counts as a word character. Underscore
// included so snake_case stays whole.
const WORD_CLASS = "\\p{L}\\p{N}_";

// A single word character.
export const wordChar: RegExp = new RegExp(`[${WORD_CLASS}]`, "u");

// Any run of non-word characters separates words. Keeps "build," and "build"
// the same token.
const wordSeparators = new RegExp(`[^${WORD_CLASS}]+`, "u");

/**
 * Splits normalized text into words on any punctuation/whitespace run, so
 * multi-word matching tokenizes "build," and "build" identically.
 */
export const splitWords = (text: string): string[] => text.split(wordSeparators).filter(Boolean);

const boundaryChars = new Set('  []()-–—\'"""'.split("").concat([".", ",", ":", ";", "/"]));

export const isBoundaryChar = (char: string): boolean => boundaryChars.has(char);

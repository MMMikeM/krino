/**
 * One boundary definition, everywhere: a word boundary is any non-word
 * character. `splitWords`, the boundary tiers, the acronym tier, and fuzzy
 * chunk admission/pricing all agree by construction.
 */

// The single source of truth for what counts as a word character (a regex
// class body). Underscore included so snake_case stays whole.
export const WORD_CHARS: string = "\\p{L}\\p{N}_";

// A single word character.
export const wordChar: RegExp = new RegExp(`[${WORD_CHARS}]`, "u");

// Any run of non-word characters separates words. Keeps "build," and "build"
// the same token.
const wordSeparators = new RegExp(`[^${WORD_CHARS}]+`, "u");

/**
 * Splits normalised text into words on any punctuation/whitespace run, so
 * multi-word matching tokenises "build," and "build" identically.
 */
export const splitWords = (text: string): string[] => text.split(wordSeparators).filter(Boolean);

export const isBoundaryChar = (char: string): boolean => !wordChar.test(char);

/**
 * One boundary definition, everywhere: a word boundary is any non-word
 * character. `splitWords`, the boundary tiers, the acronym tier, and fuzzy
 * chunk admission/pricing all agree by construction. (Historically the
 * boundary tiers used an enumerated allowlist that silently diverged — `?`,
 * `&`, `!` separated words for tokenization but weren't boundaries; the
 * unification was benchmarked before landing and moved no published cell.)
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

export const isBoundaryChar = (char: string): boolean => !wordChar.test(char);

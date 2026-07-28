import { wordChar } from "./boundaries";
import { charMask, escapeRegex } from "./gates";
import { matchField, type PreparedQuery, prepareQuery } from "./match";
import { SCORES, TYPO_PENALTY } from "./scores";
import type { HighlightRanges, MatchResult } from "./types";

// The field currently being rescued against the prepared query, allocated by
// matchField only when a field actually reaches a rescue site.
export type RescueContext = {
	field: string;
	normalisedField: string;
	fieldMask: number;
	prepared: PreparedQuery;
	acronym: boolean;
	missingClasses: number;
};

export type RescueVariant = {
	text: string;
	rawText: string;
	shortens: boolean;
	// A subset of the query mask, so `mask & missingClasses` is exactly "the
	// field lacks a class this correction still requires".
	mask: number;
	prepared: PreparedQuery | null;
};

export type RescueState = {
	variants: RescueVariant[];
	variantGate: RegExp | null;
	gate: RegExp;
};

// Below this a correction describes the field rather than the query: almost
// every field offers a window one character away from a 3-character string.
const MIN_RESCUE_QUERY_LENGTH = 4;

// Chance corrections are a multiple-comparisons problem scaling with the
// field's window count, while a high floor is paid by the short queries that
// dominate label search (@see docs/benchmarks.md).
const minTypoQueryLength = (fieldLength: number): number =>
	fieldLength <= 64 ? 5 : fieldLength <= 1024 ? 6 : 7;

// The floor for drops and substituted windows. Must equal minTypoQueryLength's
// smallest rung: the rescue gate uses it as the lowest value the field-scaled
// floor can take, and a larger constant would make that gate false-reject.
const MIN_TYPO_QUERY_LENGTH = minTypoQueryLength(0);

export const isRescuableQuery = (normalisedQuery: string, queryWords: string[]): boolean =>
	queryWords.length === 1
		? normalisedQuery.length >= MIN_RESCUE_QUERY_LENGTH
		: queryWords.some((word) => word.length >= MIN_RESCUE_QUERY_LENGTH);

// Whether the mask gate may relax to one missing class for this query.
// matchField and the searcher's survivor scan must ask this same question, or
// the searcher silently drops hits the matcher would accept.
export const admitsMissingClass = (normalisedQuery: string, queryWords: string[]): boolean =>
	queryWords.length === 1
		? normalisedQuery.length >= MIN_TYPO_QUERY_LENGTH
		: queryWords.some((word) => word.length >= MIN_TYPO_QUERY_LENGTH);

const SCORE_EPSILON = 1e-9;

// Ties break toward the one-edit reading: it names the character the user got
// wrong, where a chain only says the letters appear in order.
export const cheaper = (a: MatchResult | null, b: MatchResult | null): MatchResult | null => {
	if (a === null) return b;
	if (b === null) return a;
	if (b.score < a.score - SCORE_EPSILON) return b;
	if (a.score < b.score - SCORE_EPSILON) return a;
	return a.tier === "fuzzy" ? b : a;
};

const swapAdjacentAt = (text: string, at: number): string =>
	text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2);

const dropCharAt = (text: string, at: number): string => text.slice(0, at) + text.slice(at + 1);

// Needs normaliseText's 1:1 mapping to index the raw query by normalised
// offsets; when NFC shortened decomposed input, callers fall back to the
// normalised correction — sound, just case-blind.
const offsetsAligned = (query: string, normalisedQuery: string): boolean =>
	query.length === normalisedQuery.length;

// The correction must be the user's own text with one character changed —
// spelling it out of the field would credit an ALL-CAPS query with an
// exact-case match it never made.
const rawSubstitution = (prepared: PreparedQuery, corrected: string): string => {
	const { query, normalisedQuery } = prepared;
	if (!offsetsAligned(query, normalisedQuery)) return corrected;
	for (let i = 0; i < corrected.length; i++) {
		if (corrected[i] !== normalisedQuery[i]) {
			return query.slice(0, i) + corrected[i] + query.slice(i + 1);
		}
	}
	return corrected;
};

const rawInsertion = (
	prepared: PreparedQuery,
	gapChar: string,
	insertAt: number,
): string | null => {
	const { query, normalisedQuery } = prepared;
	return offsetsAligned(query, normalisedQuery)
		? query.slice(0, insertAt) + gapChar + query.slice(insertAt)
		: null;
};

const prepareCorrection = (
	prepared: PreparedQuery,
	rawCorrected: string,
	corrected: string,
): PreparedQuery => {
	const cached = prepared.lastRescue;
	if (
		cached !== undefined &&
		cached.query === rawCorrected &&
		cached.normalisedQuery === corrected
	) {
		return cached;
	}
	return (prepared.lastRescue = prepareQuery(rawCorrected, corrected));
};

// Only a real-tier hit (`score <= SCORES.CONTAINS`) counts: rescuing a fuzzy
// chain is an invented edit on top of a speculative assembly
// (@see docs/benchmarks.md). The rerun's `rescued` flag disables every rescue
// inside it, so the penalty cannot apply twice.
const scoreCorrectedQuery = (
	rescue: RescueContext,
	correctedQuery: PreparedQuery,
): MatchResult | null => {
	const result = matchField(
		rescue.field,
		rescue.normalisedField,
		rescue.fieldMask,
		correctedQuery,
		rescue.acronym,
		true,
	);
	return result && result.score <= SCORES.CONTAINS
		? {
				score: result.score + TYPO_PENALTY,
				tier: "corrected",
				corrected: correctedQuery.query,
				ranges: result.ranges,
			}
		: null;
};

const atRescueFloor = (best: MatchResult | null): best is MatchResult =>
	best !== null && best.score <= TYPO_PENALTY;

// Swaps and drops never collide — they differ in length. A *missing* character
// is not enumerable and is recovered from the fuzzy chain instead (see
// missingCharRescue).
const buildRescueVariants = (query: string, normalisedQuery: string): RescueVariant[] => {
	const seen = new Set<string>();
	const variants: RescueVariant[] = [];
	const aligned = offsetsAligned(query, normalisedQuery);
	const addVariant = (at: number, edit: (text: string, at: number) => string): void => {
		const text = edit(normalisedQuery, at);
		if (seen.has(text)) return;
		seen.add(text);
		variants.push({
			text,
			rawText: aligned ? edit(query, at) : text,
			shortens: text.length < normalisedQuery.length,
			mask: charMask(text),
			prepared: null,
		});
	};
	for (let at = 0; at < normalisedQuery.length - 1; at++) {
		if (normalisedQuery[at] !== normalisedQuery[at + 1]) addVariant(at, swapAdjacentAt);
	}
	if (normalisedQuery.length >= MIN_TYPO_QUERY_LENGTH) {
		for (let at = 0; at < normalisedQuery.length; at++) addVariant(at, dropCharAt);
	}
	return variants;
};

// The broad gate carries the variant texts plus the query's two halves, so one
// native test rules out the enumerated and substitution families both. It may
// only false-pass, so it uses the flat floor and leaves the real one to the
// window phase.
const buildRescueGates = (prepared: PreparedQuery): RescueState | null => {
	const variants = buildRescueVariants(prepared.query, prepared.normalisedQuery);
	const literals = variants.map((variant) => escapeRegex(variant.text));
	const variantGate = literals.length ? new RegExp(literals.join("|")) : null;
	if (prepared.normalisedQuery.length >= MIN_TYPO_QUERY_LENGTH) {
		const splitAt = prepared.normalisedQuery.length >> 1;
		literals.push(
			escapeRegex(prepared.normalisedQuery.slice(0, splitAt)),
			escapeRegex(prepared.normalisedQuery.slice(splitAt)),
		);
	}
	return (prepared.rescue = literals.length
		? { variants, variantGate, gate: new RegExp(literals.join("|")) }
		: null);
};

// By the pigeonhole principle a single substitution leaves at least one half of
// the subject intact, so those halves' occurrences are the only windows worth
// testing. Position must not rank the corrections — the rerun rescans the field.
const substitutedWindows = (normalisedField: string, subjectText: string): string[] => {
	const subjectLength = subjectText.length;
	const splitAt = subjectLength >> 1;
	const halves: [offset: number, half: string][] = [
		[0, subjectText.slice(0, splitAt)],
		[splitAt, subjectText.slice(splitAt)],
	];
	const corrections: string[] = [];
	for (const [offset, half] of halves) {
		for (
			let halfAt = normalisedField.indexOf(half);
			halfAt > -1;
			halfAt = normalisedField.indexOf(half, halfAt + 1)
		) {
			const windowStart = halfAt - offset;
			if (windowStart < 0 || windowStart + subjectLength > normalisedField.length) continue;
			let mismatches = 0;
			for (let i = 0; i < subjectLength; i++) {
				if (normalisedField[windowStart + i] !== subjectText[i] && ++mismatches > 1) break;
			}
			// Exactly one: zero would mean the contains tier already owns it.
			if (mismatches !== 1) continue;
			const corrected = normalisedField.slice(windowStart, windowStart + subjectLength);
			if (!corrections.includes(corrected)) corrections.push(corrected);
		}
	}
	return corrections;
};

const wordOffsetsOf = (prepared: PreparedQuery): number[] => {
	let offsets = prepared.wordOffsets;
	if (offsets === undefined) {
		offsets = [];
		let cursor = 0;
		for (const word of prepared.queryWords) {
			const wordAt = prepared.normalisedQuery.indexOf(word, cursor);
			offsets.push(wordAt);
			cursor = wordAt + word.length;
		}
		prepared.wordOffsets = offsets;
	}
	return offsets;
};

const wordVariantsOf = (prepared: PreparedQuery, wordIndex: number): RescueVariant[] => {
	const cache = (prepared.wordVariants ??= prepared.queryWords.map(() => null));
	let variants = cache[wordIndex];
	if (variants === null) {
		const word = prepared.queryWords[wordIndex];
		const wordStart = wordOffsetsOf(prepared)[wordIndex];
		const rawWord = offsetsAligned(prepared.query, prepared.normalisedQuery)
			? prepared.query.slice(wordStart, wordStart + word.length)
			: word;
		variants = cache[wordIndex] = buildRescueVariants(rawWord, word);
	}
	return variants;
};

const rawWordSubstitution = (
	prepared: PreparedQuery,
	wordIndex: number,
	corrected: string,
): string => {
	if (!offsetsAligned(prepared.query, prepared.normalisedQuery)) return corrected;
	const word = prepared.queryWords[wordIndex];
	const wordStart = wordOffsetsOf(prepared)[wordIndex];
	const rawWord = prepared.query.slice(wordStart, wordStart + word.length);
	for (let i = 0; i < corrected.length; i++) {
		if (corrected[i] !== word[i]) return rawWord.slice(0, i) + corrected[i] + rawWord.slice(i + 1);
	}
	return corrected;
};

const spliceCorrectedWord = (
	prepared: PreparedQuery,
	wordIndex: number,
	rawWord: string,
	corrected: string,
): PreparedQuery => {
	const wordStart = wordOffsetsOf(prepared)[wordIndex];
	const wordEnd = wordStart + prepared.queryWords[wordIndex].length;
	const normalisedCorrected =
		prepared.normalisedQuery.slice(0, wordStart) +
		corrected +
		prepared.normalisedQuery.slice(wordEnd);
	const rawCorrected = offsetsAligned(prepared.query, prepared.normalisedQuery)
		? prepared.query.slice(0, wordStart) + rawWord + prepared.query.slice(wordEnd)
		: normalisedCorrected;
	return prepareCorrection(prepared, rawCorrected, normalisedCorrected);
};

// What a rescue corrects — the whole query, or a phrase's one absent word —
// with the two ways a correction of it becomes a scoreable query.
type CorrectionSubject = {
	text: string;
	variants: RescueVariant[];
	fromVariant: (variant: RescueVariant) => PreparedQuery;
	fromWindow: (corrected: string) => PreparedQuery;
};

const wholeQuerySubject = (
	prepared: PreparedQuery,
	variants: RescueVariant[],
): CorrectionSubject => ({
	text: prepared.normalisedQuery,
	variants,
	fromVariant: (variant) => (variant.prepared ??= prepareQuery(variant.rawText, variant.text)),
	fromWindow: (corrected) =>
		prepareCorrection(prepared, rawSubstitution(prepared, corrected), corrected),
});

const absentWordSubject = (prepared: PreparedQuery, wordIndex: number): CorrectionSubject => ({
	text: prepared.queryWords[wordIndex],
	variants: wordVariantsOf(prepared, wordIndex),
	fromVariant: (variant) => spliceCorrectedWord(prepared, wordIndex, variant.rawText, variant.text),
	fromWindow: (corrected) =>
		spliceCorrectedWord(
			prepared,
			wordIndex,
			rawWordSubstitution(prepared, wordIndex, corrected),
			corrected,
		),
});

// Price the whole enumerated family before taking one — enumeration order says
// nothing about how well a variant reads — then the substituted windows: a
// subject mistyped at its first or last character has two valid readings
// ("ergonomiq" is a substitution, but dropping the "q" leaves a prefix), and
// stopping after the enumerated family would let the worse one win by default.
// A corrected exact hit is unbeatable and exits early.
const correctSubject = (rescue: RescueContext, subject: CorrectionSubject): MatchResult | null => {
	const fieldFloor = minTypoQueryLength(rescue.normalisedField.length);
	let best: MatchResult | null = null;
	for (const variant of subject.variants) {
		// Only a drop shortens, so only it answers to the field-scaled floor.
		if (variant.shortens && subject.text.length < fieldFloor) continue;
		// A variant still needing a class the field lacks cannot be contained.
		if ((variant.mask & rescue.missingClasses) !== 0) continue;
		if (!rescue.normalisedField.includes(variant.text)) continue;
		best = cheaper(best, scoreCorrectedQuery(rescue, subject.fromVariant(variant)));
		if (atRescueFloor(best)) return best;
	}
	if (subject.text.length < fieldFloor) return best;
	for (const corrected of substitutedWindows(rescue.normalisedField, subject.text)) {
		best = cheaper(best, scoreCorrectedQuery(rescue, subject.fromWindow(corrected)));
		if (atRescueFloor(best)) return best;
	}
	return best;
};

const EVERY_WORD_PRESENT = -1;
const BEYOND_ONE_EDIT = -2;

const soleAbsentWord = (normalisedField: string, words: string[]): number => {
	let absentAt = EVERY_WORD_PRESENT;
	for (let i = 0; i < words.length; i++) {
		if (normalisedField.includes(words[i])) continue;
		if (absentAt !== EVERY_WORD_PRESENT) return BEYOND_ONE_EDIT;
		absentAt = i;
	}
	return absentAt;
};

// The literal words have already pinned the field, so only the single absent
// word is corrected and the whole phrase rerun.
const multiWordRescue = (rescue: RescueContext): MatchResult | null => {
	const { prepared, normalisedField } = rescue;
	const absentAt = soleAbsentWord(normalisedField, prepared.queryWords);
	if (absentAt < 0) return null;
	if (prepared.queryWords[absentAt].length < MIN_RESCUE_QUERY_LENGTH) return null;
	return correctSubject(rescue, absentWordSubject(prepared, absentAt));
};

const typoRescue = (rescue: RescueContext): MatchResult | null => {
	const { prepared, normalisedField } = rescue;
	const gates = prepared.rescue !== undefined ? prepared.rescue : buildRescueGates(prepared);
	if (gates === null || !gates.gate.test(normalisedField)) return null;
	const variants = gates.variantGate?.test(normalisedField) ? gates.variants : [];
	return correctSubject(rescue, wholeQuerySubject(prepared, variants));
};

// A fuzzy assembly of exactly two chunks around a one-character gap is a
// dropped keystroke: the missing character is the gap itself. The gap must be a
// word character — a skipped separator is concatenated-word matching, not a
// typo. Takes the flat floor: this shape pins the correction to one contiguous
// window, so the multiple-comparisons hazard the field-scaled floor guards
// never arises (@see bench/longtext.test.ts).
export const missingCharRescue = (
	rescue: RescueContext,
	ranges: HighlightRanges,
): MatchResult | null => {
	const { prepared, normalisedField } = rescue;
	if (prepared.normalisedQuery.length < MIN_RESCUE_QUERY_LENGTH) return null;
	if (ranges.length !== 2) return null;
	const [[firstStart, firstEnd], [secondStart, secondEnd]] = ranges;
	const gapChar = normalisedField[firstEnd + 1];
	if (secondStart !== firstEnd + 2 || !wordChar.test(gapChar)) return null;

	const corrected = normalisedField.slice(firstStart, secondEnd + 1);
	const rawCorrected = rawInsertion(prepared, gapChar, firstEnd - firstStart + 1);
	return scoreCorrectedQuery(
		rescue,
		prepareCorrection(prepared, rawCorrected ?? corrected, corrected),
	);
};

export const rescueField = (rescue: RescueContext): MatchResult | null =>
	rescue.prepared.queryWords.length > 1 ? multiWordRescue(rescue) : typoRescue(rescue);

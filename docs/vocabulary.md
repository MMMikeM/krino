# Vocabulary

The current glossary and naming conventions for `src/`.
Successor to two audit-era documents, `naming.md` (0.x) and `vocab-audit.md` (1.0) — both described states the code has since left, and git history keeps them.

## The load-bearing vocabulary

Words that carry meaning across files; a maintainer should be able to trust these everywhere.

| Word | Means, everywhere | Guarded by |
|---|---|---|
| `item` | one collection element `T` | `FuzzyResult.item` |
| `field` | one searchable string extracted from an item by a `FieldSpec` | `matchField` |
| `query` | the search string (trimmed raw; `normalisedQuery` for the folded form) | `PreparedQuery` |
| `prepared` | the per-query state built once and reused across every field | `PreparedQuery`, `prepareQuery` |
| `normalised` | passed through `normaliseText` (lowercased, diacritics folded, trimmed) | every `normalised*` binding |
| `raw` | the caller's own string, before trim and fold | `rawFieldScan`, `RescueVariant.raw` |
| `tier` | which rung of the ladder matched (categorical) | `Tier`, `SCORES` |
| `score` | the numeric sort key, lower = better | `MatchResult.score` |
| `literal` | a hit at or below `SCORES.CONTAINS` — the query text actually appears | `literalPass`, `literalHits`, `literalTiers` |
| `range` | inclusive `[start, end]` span for highlighting | `Range`, `HighlightRanges` |
| `chunk` | a consecutive matched run inside the fuzzy tier (same shape as `Range`, different meaning) | `Chunk` alias |
| `chain` | an assembled sequence of chunks covering the whole query | `fuzzyChainMatch`, `ChainScore` |
| `gate` | a cheap per-query pre-filter that can only false-pass, never false-reject | `gates.ts` |
| `mask` | the 32-bit char-class summary used by the O(1) gate; every stored mask is scope-qualified (`queryMask`, `fieldMasks`, `unionMasks`, `requiredMask`) | `charMask` |
| `class` | unqualified: a charMask bucket (`bigramClass`, `missingClasses`, `classBit`); regex character classes always say "char class" | `charMask`, `escapeCharClass` |
| `bigram` | an adjacent pair of char classes, hashed into a 64-bit presence set for the rescue gate | `FieldBigrams`, `RescueBigramGate` |
| `survivor` | an item index that passed the gate for the previous query | `survivorCache` |
| `relaxed` / `relaxable` | the mask gate tolerating exactly one missing class (what a substitution typo looks like from a mask) | `relaxedPass`, `admitsMissingClass` |
| `rescue` | the one-edit correction machinery; `rescueState` is its per-query gate cache, `RescueContext` the per-field call state | `rescue.ts` |
| `variant` | one enumerated one-edit correction candidate (swap or drop) | `RescueVariant` |
| `subject` | what a rescue corrects — the whole query, or a phrase's one absent word | `CorrectionSubject` |
| `window` | a field slice exactly one substitution away from the subject | `substitutedWindows` |
| `correction` / `corrected` | the fixed query a rescue scores; `MatchResult.corrected` carries it in the caller's casing | `prepareCorrection`, tier `"corrected"` |
| `fold` | the per-code-point, length-preserving case/diacritic mapping | `normalise.ts` |
| `unfold` | the fold's inverse — folded char → every source code point, for gating un-normalised text | `unfold.ts` |
| `boundary` | any non-word character; one definition everywhere | `boundaries.ts` |
| `lead` | count of leading-whitespace units stripped from a raw field | `leads`, `shiftRanges` |

## Conventions

Schemes the code follows deliberately; new code joins them.

- **Lengths are spelled out**: `queryLength`, `chunkLength`, `subjectLength` — never `Len`.
- **Positions**: a string offset is `at` (or `<noun>At`: `soleAt`, `wordAt`, `halfAt`, `insertAt`, `splitAt`); a scan start is `from` (or `<noun>From`: `queryFrom`); an array index is `<noun>Index` (`wordIndex`, `absentIndex`).
- **Characters**: `char` is a code point as a string; `unit` is a numeric UTF-16 code unit (`charCodeAt`); `codePoint` is a numeric code point (`codePointAt`).
- **Bigram halves** carry the `Lo`/`Hi` suffix; field-side sets are `bigrams*`, query-side requirements are `required*`; the per-field accumulator keeps bare `{ lo, hi }` (`FieldBigrams`).
- **Tier probes** in match.ts are `<name>Tier(…): MatchResult | null`; `fuzzyMatch` (public) and `fuzzyChainMatch` (a chain scorer, not a rung probe) are the deliberate exceptions.
- **Ends are exclusive** in bare locals (`end`, `chunkEnd`, `wordEnd` — the JS slice idiom); inclusive ends exist only inside `Range` tuples and are always destructured `[start, end]`.
- **Predicates** read as predicates: `is*` (`isBoundaryChar`, `isExactMask`, `isRescuableQuery`), a domain verb (`admitsChunk`, `admitsMissingClass`), or `hits*` for a threshold test (`hitsRescueFloor`).
- **`*Occurrence`** returns an index or -1 (`boundaryOccurrence`, `wholeWordOccurrence`).
- **`build*` constructs fresh** per-query state (`buildFuzzyGate`, `buildRescueVariants`); **`prepare*` constructs caller-cached state** (`prepareQuery`, `prepareCorrection`); noun and `*Of` accessors may memoise transparently (`unfoldTable`, `wordStartsOf`).
- **`prefer*`** names an asymmetric selection and its parameters carry the policy: `preferCheaper(incumbent, challenger)` keeps the incumbent on ties unless it is fuzzy.
- **Raw/normalised pairs** always travel in `(raw, normalised)` order and take `raw*`/`normalised*` names when both are in scope.
- **Single letters** are for loop counters (`i`, `f`, `k`, `b`) and two-line comparators (`a`, `b`); everything else gets a word.
- **`SCREAMING_CASE`** for tuning constants (`SCORES`, `CHUNK_SCORES`, `DENSITY_FLOOR`, `TYPO_PENALTY`, `RESCUE_BUDGET`).
- **EU spelling** in identifiers and prose alike (`normaliseText`, `NORMALISED_EXACT`); only platform builtins keep theirs (`String.prototype.normalize`).

## File map

One concern per file.

| File | Concern |
|---|---|
| index.ts | the public surface |
| types.ts | the public types |
| scores.ts | the tier ladder's constants and the typo surcharge |
| boundaries.ts | word semantics: the char class, tokenisation, the boundary predicate |
| normalise.ts | the 1:1 fold, and the fused raw-field scan built on it |
| unfold.ts | the fold's inverse table for the raw gate |
| gates.ts | per-query bulk-reject pre-filters |
| match.ts | the tier ladder |
| fuzzy.ts | the fuzzy chain tier |
| rescue.ts | the one-edit typo rescue |
| search.ts | the two entry points and the collection cache |

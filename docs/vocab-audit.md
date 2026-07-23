# Vocabulary audit v2 — every assigned name in `src/`, per file

Successor to [naming.md](./naming.md), which audited the 0.x vocabulary and is now historical.
This catalogues the current state: every exported or module-level binding, notable locals, and every type, with a fitness verdict per name.
Verdicts: **✓** fits and is clear; **~** works but has a wrinkle worth knowing; **✗** rename candidate.
Nothing here is public API except where marked, so every ✗ is a cheap internal rename.

**Status:** every ✗ and ~ below is now applied (see "Cross-cutting findings"), and the file-placement follow-up at the bottom is applied too.
The per-file tables are the audit-time snapshot — old names on the left of each rename.

## The load-bearing vocabulary

Words that carry meaning across files; a maintainer should be able to trust these everywhere.

| Word | Means, everywhere | Guarded by |
|---|---|---|
| `item` | one collection element `T` | `FuzzyResult.item` |
| `field` | one searchable string extracted from an item by a `FieldSpec` | `matchField`, `PreparedField` |
| `query` | the search string (trimmed raw; `normalizedQuery` for the folded form) | `MatchQuery` |
| `normalized` | passed through `normalizeText` (lowercased, diacritics folded, trimmed) | every `normalized*` binding |
| `tier` | which rung of the ladder matched (categorical) | `Tier`, `SCORES` |
| `score` | the numeric sort key, lower = better | `MatchResult.score` |
| `range` | inclusive `[start, end]` span for highlighting | `Range`, `HighlightRanges` |
| `chunk` | a consecutive matched run inside the fuzzy tier (same shape as `Range`, different meaning) | `Chunk` alias |
| `gate` | a cheap per-query pre-filter that can only false-pass, never false-reject | `gates.ts` |
| `mask` | the 32-bit char-class summary used by the O(1) gate | `charMask` |
| `survivor` | an item index that passed the mask gate for the previous query | search.ts cache |
| `fold` | the per-code-point, length-preserving case/diacritic mapping | normalize.ts |
| `lead` | count of leading-whitespace units stripped from a raw field | `PreparedField.lead` |

Conventions observed (worth keeping deliberate):

- `*Occurrence` returns an index or -1 (`boundaryOccurrence`, `wholeWordOccurrence`); `*Match` returns a `MatchResult | null` (`acronymMatch`, `fuzzyMatch`).
- `build*` constructs per-query state (`buildFuzzyGate`, `buildPresenceGate`); `prepare*` constructs cached state (`prepareQuery`, `PreparedField`).
- `SCREAMING_CASE` for tuning constants (`SCORES`, `CHUNK_SCORES`, `DENSITY_FLOOR`, `TABLE_MAX`).

## Per-file catalogue

### index.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| (header comment) | doc | describes the library | **✗ stale** — still says "Adapted from @nozbe/microfuzz with Vite SSR compatibility"; it is Krino, inspired-by, and the SSR line is ancient history |

### types.ts (all public)

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `Range` | type | inclusive `[start, end]` | ✓ |
| `HighlightRanges` | type | `Range[]` | ✓ — plural-as-type is unusual but established public API |
| `Tier` | type | categorical match level | ✓ |
| `MatchResult` | type | `{ score, tier, ranges }` for one string | ✓ |
| `MatchOptions` | type | options for the primitive | ✓ |
| `FieldSpec` | type | one searchable field's config | ✓ |
| `FuzzyResult` | type | ranked result for one item | ✓ — `Fuzzy*` = collection level, `Match*` = single-string level; consistent |
| `FuzzySearcher` | type | the prepared search function | ✓ |
| `atBest` | field | additive demotion of a field's score | ✓ public and deliberate; reads as "ranks at best like X", which is the intent |

### scores.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `SCORES` | const (public) | the tier ladder as named constants | ✓ |

### normalize.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `normalizeText` | fn (public) | the fold pipeline | ✓ locked API |
| `splitWords` | fn (public) | tokenize on separator runs | ✓ |
| `diacriticsRegex` | const | strips U+0300–036F, global | **~** only regex with a `Regex` suffix; siblings (`combiningMark`, `nonAscii`, `wordSeparators`) go without — pick one style |
| `combiningMark` | const | presence test for decomposed input | ~ same consistency note; also singular tests "any mark", `combiningMarks` would read truer |
| `nonAscii` | const | fast-path escape hatch | ✓ |
| `wordSeparators` | const | `splitWords` splitter | ✓ |
| `computeFold` | fn | uncached single-code-point fold | ✓ pairs with `foldChar` as compute/lookup |
| `foldChar` | fn | cached fold entry point | ✓ |
| `foldTable` | const | dense cache ≤ `TABLE_MAX` | ✓ |
| `foldOverflow` | const | Map cache above `TABLE_MAX` | **~** "overflow" implies capacity exhaustion; it is the sparse-tail fallback — `foldRare` says why it exists |
| `TABLE_MAX` | const | dense-cache ceiling (U+04FF) | ✓ |

### gates.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `escapeRegex` | fn | regex-literal escaping | ✓ |
| `WORD_CHAR` | const | `[\p{L}\p{N}_]` predicate | **✗ duplicate** — `match.ts` has the identical regex as `wordChar`; two casings, two files, one meaning (see cross-cutting §3) |
| `buildFuzzyGate` | fn | in-order subsequence gate | ✓ doc now covers its double duty as single-word front gate |
| `charMask` | fn | 32-bit char-class mask | ✓ |
| `maskIsExact` | fn | "mask alone proves presence" predicate | ✓ reads well at the call site |
| `buildPresenceGate` | fn | order-independent char-presence gate | ✓ |

### match.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `MatchQuery` | type | per-query state reused across fields | **~** it is the *prepared* query; `PreparedQuery` would join the `prepare*` family alongside `PreparedField` |
| `sortByRangeStart` | fn | range comparator | ✓ |
| `wordRun` | const | word-run regex (apostrophe-internal) for initials | ✓ |
| `wordChar` | const | single word-char predicate | ✗ the duplicate of `WORD_CHAR` (§3) |
| `wholeWordOccurrence` | fn | index of first whole-word occurrence | ✓ |
| `boundaryOccurrence` | fn | index of first boundary-anchored occurrence | ✓ |
| `acronymMatch` | fn | the word-initials tier | ✓ |
| `matchField` | fn | the tier ladder | ✓ verb-first while `acronymMatch`/`fuzzyMatch` are noun-first, but "match this field" is the imperative it performs |
| `frontGate` | local | which gate front-runs the ladder for this query | ✓ |
| `q` | param | the `MatchQuery` | ✓ terse but conventional and hot |

### fuzzy.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `Chunk` | type | `Range` alias meaning "matched run" | ✓ the alias-with-rationale is the right move |
| `CHUNK_SCORES` | const | per-chunk pricing | ✓ |
| `DENSITY_FLOOR` | const | minimum matched/span share | ✓ name; **✗ stale comment** — still says it keeps "`smart`" safe; the strategy knob is dead |
| `scoreConsecutiveLetters` | fn | price an assembled chunk list + enforce the density floor | **✗** describes what a chunk *is*, not what the function *does*; it scores the assembly — `scoreChunks` |
| `smartFuzzyMatch` | fn | the one and only fuzzy matcher | **✗** "smart" is a fossil of the deleted `smart`/`aggressive` strategy enum; there is nothing for it to be smarter than — `fuzzyChainMatch` matches the docs' own vocabulary ("fuzzy chain") |
| `queryIdx`, `queryChar`, `chunkStart`, `chunkEnd`, `minChunkLen`, `minQueryChunk` | locals | scan cursors | ✓ |

### search.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `fuzzyMatch` | fn (public) | the primitive | ✓ locked |
| `createFuzzySearch` | fn (public) | the collection searcher | ✓ locked |
| `sortByScore` | fn | result comparator | ✓ |
| `toNullField` | fn | filler factory for the fields array | ✓ reads fine at its call site (`prepared.map(toNullField)`) |
| `shiftRanges` | fn | trimmed-space → raw-space offset shift | ✓ |
| `prepareQuery` | fn | build `MatchQuery` | ✓ (pairs better if the type becomes `PreparedQuery`) |
| `PreparedField` | type | cached per-field strings + `lead` | ✓ |
| `normalizedSpecs` | local | field specs with defaults resolved | **✗ collision** — "normalized" means `normalizeText` everywhere else in this codebase; these specs are *defaulted*, not folded — `resolvedSpecs` |
| `unionMasks`, `fieldMasks`, `maskBase` | locals | flat mask storage | ✓ |
| `cachedQuery`, `cachedSurvivors`, `cachedCount`, `spare` | locals | prefix-narrowing double buffer | ✓ documented in place |
| `narrowed`, `source`, `bound` | locals | scan-source selection | ~ `bound` reads as a verb at first glance; `scanCount` would be unambiguous — marginal |
| `lead` | local/field | leading-ws shift | ✓ |

### shared.ts

| Name | Kind | Role | Verdict |
|---|---|---|---|
| `shared.ts` | filename | holds exactly one boundary predicate | **✗** the repo's own history distrusts "shared" grab-bags (blog §3); the file has one concern — `boundaries.ts` |
| `validWordBoundaries` | const | enumerated boundary characters | **~** it is an allowlist of *some* punctuation, not a definition of validity; and it silently diverges from `wordChar`'s complement (`?`, `&`, `!` are boundaries to `splitWords` but not here) — `boundaryChars` claims less |
| `isValidWordBoundary` | fn | membership test | ~ follows its Set; `isBoundaryChar` if renamed together |

## Cross-cutting findings, ranked

1. **`smartFuzzyMatch` + the `DENSITY_FLOOR` comment** — the word `smart` survives only as a fossil of the deleted strategy enum.
   A maintainer who never saw 0.x will look for the "dumb" variant.
   Rename to `fuzzyChainMatch`, fix the comment.
2. **`normalizedSpecs`** — the one genuine collision with a load-bearing word.
   In a codebase where `normalized*` always means "through `normalizeText`", this binding is a lie of vocabulary.
   `resolvedSpecs`.
3. **`wordChar` / `WORD_CHAR` duplication** — identical regex defined in `match.ts` and `gates.ts` under two casings.
   Consolidate to one export; `shared.ts`→`boundaries.ts` is its natural home next to the boundary predicate, which would also surface the known semantic divergence between the two boundary definitions in one file.
4. **`scoreConsecutiveLetters`** — names its input's shape, not its action; `scoreChunks` says what it does with the vocabulary the file already established.
5. **`shared.ts` → `boundaries.ts`**, **`validWordBoundaries` → `boundaryChars`** — smaller claims, truer names, one concern per file.
6. Cosmetic, batchable: `diacriticsRegex` suffix consistency, `combiningMark` plural, `foldOverflow` → `foldRare`, `MatchQuery` → `PreparedQuery`, `bound` → `scanCount`, and the stale `index.ts` header.

None of these touch the public surface; `.d.ts` stays byte-identical throughout.

## File-placement audit (v2 follow-up)

Same method, different question: is each thing defined in the file a maintainer would look for it in?

### Acted on

| Thing | Was | Problem | Now |
|---|---|---|---|
| `matchDensity` + `density.ts` | public export, own file | the v1.0 plan's own open call ("say the word and I cut it"): a building block with zero internal consumers, duplicating the maths `scoreChunks` inlines, that the maintainer didn't recognise | **cut** — file, test, export, README/CHANGELOG/MIGRATION mentions (unpublished, so not breaking) |
| `splitWords` + `wordSeparators` | normalize.ts | tokenization, not folding — normalize.ts's one concern is the 1:1 fold | **moved to boundaries.ts**, which now owns all word semantics |
| word-class duplication | `wordChar` and `wordSeparators` each hard-coded `\p{L}\p{N}_` | two regexes, one class, drift risk | both built from a single `WORD_CLASS` source string |

### Checked and judged fine

| Thing | Where | Why it stays |
|---|---|---|
| `PreparedQuery` type | match.ts | built in search.ts but it is the *contract of matchField's input* — lives with its consumer |
| `wordRun` | match.ts | derived from the word class but its apostrophe-internal semantics are acronym-tier-specific; belongs next to `acronymMatch` |
| `acronymMatch` inside match.ts vs `fuzzy.ts` as own file | match.ts | asymmetry is size, not concern: the acronym tier is 15 lines, the chunk matcher is 100 |
| `fuzzyMatch` + `createFuzzySearch` sharing search.ts | search.ts | both are the public entry points; the primitive is 15 lines and the collection searcher is built on it |
| `charMask` | gates.ts | consumed by search and match, but it *is* the O(1) gate — concern over consumer |
| `SCORES` vs `CHUNK_SCORES` in separate files | scores.ts / fuzzy.ts | documented deliberate: same value for BASE/CONTAINS, different meanings, must be able to diverge |
| `shiftRanges`, `sortByScore`, `toNullField` | search.ts | single-consumer helpers; a utils file would be a "shared" grab-bag by another name |

Current file map, one concern each:

| File | Concern |
|---|---|
| index.ts | the public surface |
| types.ts | the public types |
| scores.ts | the tier ladder's constants |
| boundaries.ts | word semantics: the char class, tokenization, boundary predicate |
| normalize.ts | the 1:1 fold |
| gates.ts | per-query bulk-reject pre-filters |
| match.ts | the tier ladder |
| fuzzy.ts | the fuzzy chain tier |
| search.ts | the two entry points and the collection cache |

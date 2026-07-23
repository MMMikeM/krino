# Naming audit

An audit of the vocabulary used across `src/`. It records what each term means
and flags where the same concept was named inconsistently, with a canonical name
per case.

**Status:** the canonical names are now applied in `fuzzy.ts`, `match.ts`, and
`search.ts` — items (a)–(g), (i), (l), (m), (o) below. The remaining items
(h, j, k, n) stay doc-only because they touch the public API (`FuzzyResult.matches`,
`FuzzySearchOptions.getText`, the `text` param of `fuzzyMatch`, the `"off"`
strategy) or the code is intentionally left as-is. The Nouns/Verbs tables above
describe the pre-rename vocabulary and its history; the canonical glossary at the
bottom is the current state.

## Nouns

| Noun | Meaning | Where |
|---|---|---|
| `item` | **Overloaded.** (1) a single raw field string; (2) the whole collection element `T`. | `matchesFuzzily` param; `createFuzzySearch` inner `item`; public `FuzzyResult.item` |
| `element` | one collection entry `T` | `createFuzzySearch` map var, query loop |
| `collection` | the input array `T[]` | `createFuzzySearch` param |
| `text` / `texts` | a raw searchable string / the array of them for one element | public `fuzzyMatch(text,…)`; `createFuzzySearch`; `getText` |
| `field` | conceptual: one searchable string per element | types doc ("each text field") — no literal identifier |
| `query` | the raw search string | everywhere |
| `queryWords` | query split on `" "` | `fuzzyMatch`, `createFuzzySearch`, `matchesFuzzily` |
| `itemWords` / word `Set` | set of normalized item words | `matchesFuzzily`, preprocessing |
| `match` / `matches` | (1) a single `[score, ranges]` result; (2) `FuzzyResult.matches` per-field list; (3) local `matches` | `matchesFuzzily`, `FuzzyResult`, `createFuzzySearch` |
| `Range` | `[number, number]` inclusive — **reused** for highlight spans and chunk index-pairs | `types.ts`, `sortRangeTuple`, `indices` elements |
| `HighlightRanges` | `Range[]` | types, return shapes |
| `FuzzyMatches` | `Array<HighlightRanges \| null>` | types, `matches` |
| `chunk` | a run of consecutive matched indices | `scoreConsecutiveLetters`, `fuzzy.ts` (`chunkFirstIdx`/`chunkLastIdx`/`chunkLength`/`minChunkLen`) |
| `indices` | **misnomer:** a `HighlightRanges` (list of chunk pairs), not bare indices | `scoreConsecutiveLetters`, both strategies |
| `score` | numeric match quality, lower = better | everywhere |
| `tier` | the ladder levels 0/0.1/0.5/… | header docstring, `SCORE_*` constants |
| `boundary` / word boundary | delimiter characters | `shared.ts` (`validWordBoundaries`, `isValidWordBoundary`) |
| `word` | a token; also start/end-of-word tests | `queryWords`, `itemWords`, `isStartOfWord`, `isEndOfWord` |
| `occurrence` | position where the query occurs | `containsIdx`, `exactContainsIdx` |
| `strategy` | `"off" \| "smart" \| "aggressive"` | `FuzzySearchStrategy`, `options.strategy`, `matchesFuzzily` |
| `result` / `results` | a match result / the result list | `matchesFuzzily` local, `FuzzyResult`, `createFuzzySearch` |
| `searcher` | the prepared query closure | `FuzzySearcher` |
| `options` | search config | `FuzzySearchOptions` |
| `key` | property name to read | `options.key` |
| `getText` | field extractor fn | `options.getText` |
| `preprocessed` / `processed` | precomputed per-element / per-field tuples | `createFuzzySearch` |
| `normalizedItem` / `normalizedText` / `normalized` | the normalized field string (three names) | `matchesFuzzily` / `fuzzyMatch` / `createFuzzySearch` |
| `queryChar` | current query character | `fuzzy.ts` strategies |
| `minQueryChunk` | query slice for the smart lookahead | `smartFuzzyMatch` |
| Idx family | `idx, itemIdx, queryIdx, chunkFirstIdx, chunkLastIdx, containsIdx, exactContainsIdx` | positions/counters |
| Len family | `queryLen, normalizedItemLen, normalizedQueryLen, chunkLength, minChunkLen, queryCharsLeft, itemCharsLeft` | lengths |
| `SCORE_*` / `CHUNK_*` / `FUZZY_BASE` | named score constants | `shared.ts` |
| `MAX_SAFE_INTEGER` | "no field matched yet" sentinel | `createFuzzySearch` |
| `diacriticsRegex` / `regexŁ` / `regexÑ` | normalization regexes | `normalize.ts` |

## Verbs

| Verb | Meaning | Where |
|---|---|---|
| normalize | fold to canonical form | `normalizeText` |
| match | test/score a string vs a query | `fuzzyMatch`, `matchesFuzzily`, `aggressive`/`smartFuzzyMatch` |
| score | assign numeric quality | `scoreConsecutiveLetters` |
| create | build a searcher | `createFuzzySearch` |
| search | run a query over the collection | the returned closure |
| sort | order results / ranges | `sortByScore`, `sortRangeTuple`, `.sort` |
| startsWith / contains (`indexOf`) | substring tests | `matchesFuzzily`, strategies |
| isValidWordBoundary / isStartOfWord / isEndOfWord | boundary predicates | `shared.ts`, `scoreConsecutiveLetters` |
| preprocess / extract (`getText`·`key`) | precompute per-element data | `createFuzzySearch` |
| split / slice | tokenize / substring | `normalize.ts`, strategies |
| push / every / has / min | accumulate / all-words / membership / minimum | throughout |

## Inconsistencies

Applied items are marked ✅; doc-only items are marked ✍️.

- ✅ **(a)–(g), (i), (l), (m), (o)** — applied in `fuzzy.ts` / `match.ts` / `search.ts`.
- ✍️ **(h), (j), (k), (n)** — left as-is (public API or intentional).

- **(a) `item` overloaded** — a single raw field-string (`matchesFuzzily`) vs the whole
  collection element (`FuzzyResult.item`). → Reserve `item` for the element (it's baked
  into the public type); rename the field-string sense to **`field`**.
- **(b) `element` vs `item` vs "result item"** — one concept, three names. → Canonical
  collection-entry term is **`item`** (public, immovable); rename internal `element → item`.
- **(c) `text` vs `item` both mean a raw field-string.** → Canonical searchable-string
  term is **`field`**; public `fuzzyMatch(text, …)` may keep `text` as a documented alias.
- **(d) `Range` reused** for highlight spans and chunk index-pairs. → Introduce an internal
  alias **`type Chunk = Range`** for the fuzzy runs; keep `Range` for highlight spans
  (structurally identical, pure documentation).
- **(e) `indices` local IS a `HighlightRanges`.** → Rename **`indices → chunks`** (`Chunk[]`).
- **(f) `matchesFuzzily` reads like a boolean predicate** but returns `[score, ranges] | null`.
  → **`matchField`** (or `rankField`).
- **(g) `chunkFirstIdx`/`chunkLastIdx`/`firstIdx`/`lastIdx` vs `Range`'s documented `start`/`end`.**
  → Standardize on **`start`/`end`**.
- **(h) `"off"` strategy ≠ "matching off"** — exact/prefix/contains tiers still run; only the
  fuzzy fallback is disabled. Also `fuzzyMatch` hardcodes `"smart"`, so `"off"`/`"aggressive"`
  are unreachable through `fuzzyMatch`. → Document that `strategy` governs **only the fuzzy
  fallback tier**.
- **(i) `Len` (abbrev) vs `chunkLength` (spelled out).** → Standardize on **`Len`**.
- **(j) `matches` is a double-plural** — a per-field list whose entries are themselves range
  lists. → Document as "per-field highlight lists"; consider **`fieldMatches`**.
- **(k) `getText` returns `Array<string | null>`** despite the singular name. → Note canonical
  intent **`getFields`**/`getTexts` (public — would need a compat shim to change).
- **(l) `preprocessed` vs `processed`** differ only by prefix, easy to confuse. → Rename inner
  **`processed → fields`**.
- **(m) `normalizedItem` / `normalizedText` / `normalized`** — three names for one thing. →
  Canonical **`normalizedField`**.
- **(n) `queryChar: string` can be `undefined`** once `queryIdx` runs past the query end (the
  code relies on the coercion in `indexOf`). → Type-honesty note; behavior is fine, leave the code.
- **(o) `sortByScore` (by-what) vs `sortRangeTuple` (of-what)** — mismatched naming scheme. →
  Rename **`sortRangeTuple → sortByRangeStart`** for a parallel `sortBy…` scheme.

## Canonical glossary (target vocabulary)

- **`item`** — a collection entry (public, via `FuzzyResult.item`).
- **`field`** — one raw searchable string extracted from an item.
- **`normalizedField`** — a field after `normalizeText`.
- **`chunk`** (`type Chunk = Range`) — a consecutive run of matched characters.
- **`Range`** — a highlight span `[start, end]`, inclusive.
- **`matches`** — per-field highlight lists.
- **`matchField`** — rank one field against a query.
- **`start` / `end`** — the bounds of a range or chunk.
- **`SMART_MIN_CHUNK`** — the smart strategy's minimum mid-word lookahead width (the `3` in
  `Math.min(3, …)`).

## v1.0.0 vocabulary

Primitive-first redesign — `fuzzyMatch` scores one string, `createFuzzySearch` composes it.

- **`MatchResult`** — the primitive's return: `{ score, tier, ranges }`. Reused as the
  per-field entry in `FuzzyResult.fields`.
- **`tier`** / **`Tier`** — categorical match kind (`"exact"` … `"fuzzy"`), returned alongside
  the numeric `score`. Tier names map 1:1 to `SCORES` keys, plus `"fuzzy"`.
- **`FuzzyResult`** — `{ item, score, fields: (MatchResult | null)[] }`. The old parallel
  `matches` + `scores` arrays are gone; one `fields` array replaces them.
- **`FieldSpec`** (public) — one searchable field: `{ text, strategy?, acronym?, atBest? }`.
  `text` is the extractor (`(item) => string | null`); replaces the old stringly `key`.
- **`atBest`** — shifts every score from the field by this amount, so the field's best possible
  hit (exact, 0) ranks at exactly this value; higher demotes (lower is better).
  Demote-only (kept ≥ 0). Introduced as `penalty`, renamed pre-release: the value is the same
  number, but the name states the intent (`atBest: SCORES.CONTAINS` = "this field's best hit
  ranks like a bare contains") instead of the mechanism. `atBest ⊂ rank` (rank deferred).
- **`acronym`** — opt-in tier matching word-initials; `acronymMatch` reads initials via the
  `wordRun` regex `/[\p{L}\p{N}_]+/u` (same word definition as `splitWords`).
- **`SCORES`** (`src/scores.ts`) — exported tier constants; single source of truth.
- **`CHUNK_SCORES`** (`src/fuzzy.ts`) — internal fuzzy-chunk bonuses; `BASE` equals
  `SCORES.CONTAINS` by design, not by a shared binding.
- **`MatchQuery`** (`src/match.ts`) — query-derived state (`query`, `normalizedQuery`,
  `queryWords`, `fuzzyGate`) built once per query.
- **`buildFuzzyGate`** (`src/fuzzy.ts`) — the native subsequence regex gate for the fuzzy tier.
- **`PreparedField`** (`src/search.ts`) — internal per-item cached field: `{field,
  normalizedField, fieldWords, strategy, acronym, atBest}`.
- **`matchDensity`** (`src/density.ts`) — matched-chars ÷ inclusive span helper.
- **`splitWords`** (`src/normalize.ts`, exported) — tokenizer on `/[^\p{L}\p{N}_]+/u`.

**Tokenization asymmetry (documented):** `splitWords` splits on any non-alphanumeric run,
while `isValidWordBoundary` recognizes an explicit set (spaces, brackets, dashes, quotes,
`. , : ; /`). So `"c/c++ lang"` tokenizes for the word `Set` slightly differently than
boundaries are detected for the boundary/acronym tiers. Pre-existing tension, not a bug.

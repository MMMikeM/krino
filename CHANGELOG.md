# Changelog

## 2.0.0 (unreleased)

- **Added: one-edit typo tolerance.**
  A single `corrected` tier covers every one-character correction the *query* needed: an adjacent swap ("geenric"), one character too many ("generric"), one missing ("genric"), one wrong ("genaric").
  Measured as MRR of the intended item over the ascii corpus, before → after: insertion **0.004 → 0.998**, substitution **0.000 → 0.996**; deletion already matched via the fuzzy tier and now ranks as a typo (0.968 → 0.962 at the new penalty).
  Long-text junk rate stays at **0%**.
- **Breaking:** typo corrections now sort *below* every literal tier. The penalty over the corrected query's tier went 0.9 → **2.1**, so even a corrected exact hit (2.1) sits under a true `contains` (2). A correction is a guess about what the user meant; a substring match is something they actually typed. At the old 0.9 the guess won, and it was measurable — infix queries lost the intended item from MRR 0.973 to 0.906. `score <= SCORES.CONTAINS` is now exactly "the query text appears here", and is the one-liner for opting out of typo tolerance.
- **Faster: the pre-filter now anchors where the chunk assembler would actually start.**
  The fuzzy gate was a bare subsequence test, so it admitted every field whose characters appeared in order, and the tier ladder then rejected 64% of them.
  `fuzzyChainMatch` only ever begins a chain at a placement that opens a word or runs the query's first three characters consecutively, and every earlier tier satisfies one of those too, so requiring the anchor cannot reject anything the ladder would have accepted.
  Fields reaching the ladder drop by **32%** (ascii) and **39%** (mixed); per-query time, measured paired in a single process, drops **12%** on ascii and **8%** on mixed at both 10k and 100k.
  Result sets are identical everywhere and no MRR moves — `bench/funnel.test.ts` now asserts the false-pass-only property per field rather than only in aggregate.
- **Fixed:** the fuzzy tier no longer strands its assembly on a decoy word-initial. It used to take the leftmost admissible placement of every chunk and never reconsider, so a query whose first character also opens an *earlier* word (`"towls"` hitting the `T` of `"Tasty Silk Towels"`) either missed outright or paid for a lone 1-character chunk it never needed. The first chunk is now retried from up to four admissible placements, cheapest assembly wins. Over the ascii bench corpus: **307 → 0** missed assemblies and 131 → 30 needlessly expensive ones, at query-time parity (+0.9% on fuzzy-heavy scatter queries, 0% on plain word queries). The residual 30 are later-chunk placements, left deliberately — see below.
- **Breaking:** the `Tier` union replaces `transposed` with `corrected`, one value for every one-edit correction, and `MatchResult` gains `corrected?: string` — the fixed query, in the caller's own casing.
  Which edit fired was never actionable and nothing branched on it; it is derivable by diffing the correction against the query, and the corrected text is what a "Showing results for …" notice actually needs.
  A TypeScript consumer with an exhaustive `switch` over `Tier` must replace its `transposed` arm; `score <= SCORES.CONTAINS` still separates literal matches from speculative ones without naming any tier.
- **Breaking:** the `strategy` option is gone entirely — `FieldSpec` is now `{ text, acronym?, atBest? }` and `MatchOptions` is `{ acronym? }`.
  - `"aggressive"` existed to reproduce `@nozbe/microfuzz`'s any-subsequence matcher; Krino's chunking (word-boundary or 3+ char runs) is the library's point, and one opinionated mode beats two overlapping ones. Stay on microfuzz or pin Krino 1.x if you need it.
  - `"off"` existed to dodge the long-text junk hazard, and the new **density floor** removes the hazard itself instead: the fuzzy tier rejects any chunk assembly covering less than 18% of its span (measured junk chains ≤ 0.143 density, sparsest genuine match 0.211). Junk rate over document-length text: 5–98% across measured lengths → **0%**, with label behaviour unchanged. Literal-only filtering stays a one-liner: drop results with `tier === "fuzzy"`.

## Renamed to `Krino`

`@mmmike/mikrofuzz` is now **`Krino`** (unscoped), same 1.0 API. The old package is deprecated in favour of `Krino`; update the import from `@mmmike/mikrofuzz` to `Krino`.

## 1.0.0

A primitive-first redesign. The library is now a rich single-string matcher
(`fuzzyMatch`) plus a thin, cached collection search (`createFuzzySearch`) built on
it — instead of one function with a growing options bag.

See [MIGRATION.md](./MIGRATION.md) for a 0.x → 1.0 upgrade guide.

### Breaking

- **`fuzzyMatch(text, query, options?)`** returns **`{ score, tier, ranges }`** (or
  `null`) — was `{ item, score, matches, scores }`. `ranges` is the field's
  `HighlightRanges` directly (no per-field wrapper array). Adds `options`
  (`{ strategy?, acronym? }`).
- **`createFuzzySearch`** second arg is a **`getText` function** or an **array of
  field specs** — the `{ key, getText, strategy, acronym, fields }` options object is
  gone. `key` (stringly property name) is **removed** — use `(item) => item.name`.
- **Result shape** is `{ item, score, fields: Array<MatchResult | null> }` — the
  parallel `matches` and `scores` arrays are replaced by one `fields` array of
  `{ score, tier, ranges }`.
- New **`tier`** on every match: a categorical name (`"exact"` … `"fuzzy"`) alongside
  the numeric score.
- `getText` returns a single string per field (was `Array<string | null>`); use
  multiple field specs for multiple fields.

### Added

- **`tier`** categorical match kind; **`Tier`** type.
- **`fuzzyMatch` options** — per-call `strategy` and `acronym`.
- **Per-field specs** with `strategy` / `acronym` / `atBest` (demote-only; introduced as `penalty`, renamed before release).
- **`splitWords`** exported; **`SCORES`** exported.
- Generic inference — `getText` / `FieldSpec<T>` are typed to the item, no cast.

### Fixed (carried from the bug-fix pass)

- Punctuation (`. , : ; /`) is a word boundary; words tokenize on any non-alphanumeric run.
- Boundary-contains scans past mid-word occurrences; highlights land on the standalone word.
- Multi-word tier is a flat `1.5` (more words no longer ranks worse).
- Empty query → `null` / `[]`.
- Highlight width uses the normalized query length.

### Performance

- Native regex subsequence gate on the fuzzy tier (`buildFuzzyGate`): ~2× faster
  query throughput on fuzzy-heavy workloads, behavior-identical.
- Front-of-ladder pre-filter that bulk-rejects non-candidate fields before any tier
  runs, picked per query type: single-word queries gate on the subsequence
  `buildFuzzyGate` (stricter, single pass); multi-word queries on the
  order-independent `buildPresenceGate` (safe for out-of-order matches). ~2.2×
  faster query throughput at 100k items and ~25% at 1k/10k, behavior-identical.

## 0.1.0

Initial release: zero-dependency fuzzy search with smart word-boundary matching.

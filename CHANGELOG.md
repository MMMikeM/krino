# Changelog

## 2.0.0 (unreleased)

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
- **`splitWords`** exported; **`SCORES`** exported; **`matchDensity`** helper.
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

# Krino

A tiny, typed fuzzy matcher. ~2.3 kB gzip, TS-first, dual ESM/CJS, zero deps. Inspired by [@nozbe/microfuzz](https://github.com/Nozbe/microfuzz)

What makes Krino different?

1. **Tiny:** ~2.3 kB gzip, zero dependencies.
2. **Informative:** returns the `ranges` it matched and a `tier` naming the kind of match ✖️ so you can rank, highlight, and explain a result without reverse-engineering a float.
3. **Focused:** a fuzzy text matcher that handles diacritics and acronyms. Trades off handling typos (edit-distance and Bitap matching) for size and speed.

For filtering a list you already have, command palettes, pickers, autocomplete, as fast and ergonomic as possible.

## Install

```bash
pnpm add krino
```

> **Coming from `@mmmike/mikrofuzz`?** See [MIGRATION.md](./MIGRATION.md).

## Two entry points

### `fuzzyMatch` — score one string

```typescript
import { fuzzyMatch } from "krino";

fuzzyMatch("Hello World", "wor");
// { score: 1, tier: "boundary", ranges: [[6, 8]] }

fuzzyMatch("cherry", "xyz"); // null
```

Options: `fuzzyMatch(text, query, { strategy?, acronym? })`.

### `createFuzzySearch` — search a collection

```typescript
import { createFuzzySearch, SCORES } from "krino";

// array of strings
const search = createFuzzySearch(["apple", "banana", "cherry"]);
search("ban");
// [{ item: "banana", score: 0.5, fields: [{ score: 0.5, tier: "prefix", ranges: [[0, 2]] }] }]

// objects — a function extracts the text to search
const byName = createFuzzySearch(users, (u) => u.name);
byName("john");

// multiple fields, per-field config
const search = createFuzzySearch(posts, [
  { text: (p) => p.title, strategy: "smart" },
  { text: (p) => p.body, strategy: "off", penalty: SCORES.CONTAINS }, // body never outranks title
]);
```

Results are sorted best-first (stable), and preprocessing is cached — build once, query many.

## Scoring

Lower is better. Each match reports a numeric `score` (for sorting) and a categorical `tier`:

| score | tier               | meaning                                    |
|-------|--------------------|--------------------------------------------|
| 0     | `exact`            | exact match                                |
| 0.1   | `normalized-exact` | case / diacritics-insensitive exact        |
| 0.5   | `prefix`           | starts with query                          |
| 0.9   | `boundary-exact`   | at a word boundary, exact case             |
| 1     | `boundary`         | at a word boundary                         |
| 1.5   | `multi-word`       | all query words present, any order         |
| 1.8   | `acronym`          | word initials (opt-in via `acronym: true`) |
| 2     | `contains`         | contains query anywhere                    |
| > 2   | `fuzzy`            | fuzzy chain (fewer chunks = better)        |

Import `SCORES` for thresholds and penalties; or read `tier` directly:

```typescript
results.filter((r) => r.score <= SCORES.CONTAINS); // drop fuzzy chains
results.filter((r) => r.fields[0]?.tier !== "fuzzy"); // same, categorically
```

> **Long text:** fuzzy strategies assemble short queries out of scattered chunks, so over document-length text almost anything "matches".
> Scope `smart` to short labels (titles, names); use `strategy: "off"` for long body text.

> **Acronym semantics:** apostrophes are word-internal (`People's` → initial `p`, so `lpdr` matches `Lao People's Democratic Republic`), and stopwords are not skipped (`drc` won't acronym-match `Democratic Republic of the Congo` — it still surfaces via the fuzzy tier).

## Strategies

| strategy          | matches                                              |
|-------------------|------------------------------------------------------|
| `smart` (default) | word boundaries or 3+ character chunks               |
| `off`             | exact / prefix / boundary / contains only (no fuzzy) |

## Comparison

| Library                                                     | Per-field | Ranges | Diacritics | ESM | Multi-word | Typos | Tier |
|-------------------------------------------------------------|:---------:|:------:|:----------:|:---:|:----------:|:-----:|:----:|
| **krino**                                                   |    🟢     |   🟢   |     🟢     | 🟢  |     🟢     |   ➖   |  🟢  |
| [@nozbe/microfuzz](https://github.com/Nozbe/microfuzz)      |    🟢     |   🟢   |     🟢     |  ➖  |     🟢     |   ➖   |  ➖   |
| [fast-fuzzy](https://github.com/EthanRutherford/fast-fuzzy) |    🟢     |   ⚪    |     ➖      | 🟢  |     ➖      |  🟢   |  ➖   |
| [Fuse.js](https://www.fusejs.io/)                           |    🟢     |   ⚪    |     ⚪      | 🟢  |     ⚪      |  🟢   |  ➖   |
| [fuzzy](https://github.com/mattyork/fuzzy)                  |     ➖     |   ⚪    |     ➖      |  ➖  |     ➖      |   ➖   |  ➖   |
| [fuzzysort](https://github.com/farzher/fuzzysort)           |    🟢     |   🟢   |     🟢     |  ➖  |     🟢     |   ➖   |  ➖   |
| [match-sorter](https://github.com/kentcdodds/match-sorter)  |    🟢     |   ➖    |     🟢     |  ⚪  |     ➖      |   ➖   |  🟢  |
| [uFuzzy](https://github.com/leeoniya/uFuzzy)                |     ➖     |   🟢   |     ⚪      |  ⚪  |     ⚪      |   ⚪   |  ➖   |

🟢 built-in / on by default
⚪ opt-in or partial
➖ not supported

Krino is the only library that by default:

- returns a categorical **`tier`** *and* numeric `ranges`
- folds diacritics
- matches multi-word
- takes per-field config

It was originally written for matching in-memory lists on the client, but it has proven to be a competitive option for serverside work.

At the sizes krino targets — hundreds to a few thousand items — every non-typo library here answers a query in **well under a millisecond**, so raw speed rarely decides. What differs is **what you get back**. Each cell above is verified against the library's current source.

### Results, in short

Full method and data live in [docs/benchmarks.md](./docs/benchmarks.md) — per-query match/rank tables, two-corpus speed tables, and how the benches verify matching before timing it.

- **Match quality** (10,000 items; every query derived from a real corpus item): krino returns the smallest result set of the subsequence libraries and ranks the source item **first on every structured query** (word, two words, prefix).
  A one-char slip still matches (source in the top 10); at two dropped chars `smart` returns nothing where the parent returns 135 junk chains — that refusal is krino's deliberate change to microfuzz's matcher.
  The typo engines return up to ~450 candidates for a single true hit; uFuzzy's defaults silently return 0 on accent-stripped and gapped queries.
- **Speed** (per-query mean): ~0.1–0.3 ms at 10k and ~2–5 ms at 100k (anything below 10k is universally sub-millisecond) — ~4–5× faster than its parent microfuzz on ascii and ~10× on the mixed corpus.
  On accented data krino now leads every configuration outright, including uFuzzy with folding enabled; on pure-ascii corpora uFuzzy keeps a ~1.5× lead at 100k.
  A prefix-narrowing cache makes typing decay toward sub-millisecond keystrokes (15 keystrokes over 100k items: ~28 ms total); a 100k list swap costs a one-time ~31 ms build.
  Benches consume every result (no dead-code elimination), verify match counts per query, and run on two seeded corpora (ascii, and mixed with ~5% diacritics).

### What to pick when

- **Typos must still match** (user-typed queries over messy data) — `Fuse.js` (Bitap) or `fast-fuzzy` (edit-distance), at a bundle and ergonomics cost.
- **100k+ pure-ascii items, raw speed above everything** — `uFuzzy`; ~1.5× faster than krino there, but no tier, and its diacritics/multi-word are opt-in. On accented data, krino now measures fastest outright.
- **Rank, highlight, and explain matches** (palettes, pickers, autocomplete) — krino: `tier` + `ranges` + per-field config, ~2.3 kB.
- **Sorting utility with tiered ranking, no highlights needed** — `match-sorter`; no ranges, no multi-word.
- **Smallest possible, plain substring is enough** — `fuzzy` (~0.8 kB, 2016-era).
- **Already on `@nozbe/microfuzz`** — krino is its rebuild: same subsequence approach plus tier, ESM, and it's faster.

Partial/opt-in details:

- `uFuzzy` folds diacritics via `latinize()`, matches multi-word via `outOfOrder`, and tolerates one typo via `SingleError`
- `Fuse` returns `ranges` via `includeMatches`, folds diacritics via `ignoreDiacritics`, and matches multi-word via token search
- `fast-fuzzy`'s `ranges` are one span (`index`+`length`), not per-character, and its default normalization doesn't strip accents
- `fuzzy`'s "ranges" are a pre-wrapped string, not numeric indices
- ESM ⚪: `match-sorter` and `uFuzzy` ship an ESM build via the legacy `module` field only (no `exports` map) — bundlers pick it up, Node `import` falls back to CJS interop. 🟢 = dual ESM/CJS with a proper `exports` map.


## Building blocks

- `normalizeText(str)` ✖️ lowercase, strip diacritics.
- `splitWords(str)` ✖️ tokenize on any non-alphanumeric run (keeps `_`).
- `matchDensity(ranges)` ✖️ matched characters ÷ inclusive span (a junk-chain discriminator).
- `SCORES` ✖️ the tier constants.

## Types

```typescript
type Range = [number, number]; // [start, end] inclusive
type Strategy = "off" | "smart";
type Tier =
  | "exact" | "normalized-exact" | "prefix" | "boundary-exact"
  | "boundary" | "multi-word" | "acronym" | "contains" | "fuzzy";

type MatchResult = { score: number; tier: Tier; ranges: Range[] };

type FieldSpec<T> = {
  text: (item: T) => string | null;
  strategy?: Strategy;   // default "smart"
  acronym?: boolean;     // default false
  penalty?: number;      // added to this field's score; higher demotes it
};

type FuzzyResult<T> = {
  item: T;
  score: number;                       // min effective score across fields
  fields: Array<MatchResult | null>;   // one per field spec
};
```

## The name

Krino, from Ancient Greek κρίνω (KREE-no), PIE `*krey-`, "to sift, separate." The same root as criterion, discern, and critic. A fuzzy matcher sifts a list and judges each candidate against a criterion.

## License

MIT

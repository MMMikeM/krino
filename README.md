# Krino

> Tiny, typed fuzzy matching

- **~2.6 kB** gzip, zero dependencies, TS-first, ESM/CJS
- **0.09 ms** per query over 10k items, ~1.3 ms over 100k, optimised for search-as-you-type
- **Tops match-quality scorecard** across 13 tests
- **Returns** `tier`, `ranges` and `score` on every match: easily rank, highlight and explain
- **Diacritics, multi-word, acronyms** built in

Krino (Ancient Greek κρίνω, KREE-no, "to sift, separate"; the root of criterion, discern, and critic) is a fuzzy text matcher: it sifts a list and judges each candidate against a criterion.
Less typo-tolerant than the edit-distance engines, in exchange for the size and speed.
Inspired by [@nozbe/microfuzz](https://github.com/Nozbe/microfuzz), and [benchmarked](./docs/benchmarks.md) against it and six others.

## Install

```bash
npm i krino  # or pnpm add krino
```

> **Coming from `@mmmike/mikrofuzz`?** See [MIGRATION.md](./MIGRATION.md).

## Usage

### `createFuzzySearch`: search a collection

```typescript
import { createFuzzySearch, SCORES } from "krino";

// array of strings
const search = createFuzzySearch(["apple", "banana", "cherry"]);
search("ban"); // [{ item: "banana", score: 0.5, fields: [...] }]

// objects: a function extracts the text to search
const byName = createFuzzySearch(users, (u) => u.name);
byName("john");

// multiple fields, per-field config
const posts = [
  { title: "Banana bread", body: "best baked goods" },
  { title: "Release notes", body: "banana picker shipped" },
];
const byField = createFuzzySearch(posts, [
  { text: (p) => p.title },
  { text: (p) => p.body, atBest: SCORES.CONTAINS }, // body's best hit ranks like a bare contains
]);
byField("ban");
// [
//   { item: posts[0], score: 0.5, fields: [{ score: 0.5, tier: "prefix", ranges: [[0, 2]] }, null] },
//   { item: posts[1], score: 2.5, fields: [null, { score: 2.5, tier: "prefix", ranges: [[0, 2]] }] },
// ]
// item score = the best field score; body scores are shifted by atBest (0.5 + 2 = 2.5),
// so the title hit leads even though both are prefix matches.
```

Results are sorted best-first (stable), and preprocessing is cached; the index is built on the first call and reused by every query after.

### `fuzzyMatch`: the primitive underneath

Scores one string against a query; reach for it directly when there is no list, e.g. matching inside a document.

```typescript
import { fuzzyMatch } from "krino";

fuzzyMatch("Hello World", "wor");
// { score: 1, tier: "boundary", ranges: [[6, 8]] }

fuzzyMatch("cherry", "xyz"); // null
```

Options: `fuzzyMatch(text, query, { acronym? })`.
`acronym: true` adds the initials tier (`rsaw` finds "Rath, Streich and Witting" at rank 1) for a sub-millisecond bump in query cost.

## Where it fits

- **Command palettes and pickers**: `tier` + `ranges` rank and highlight results without reverse-engineering a score.
- **Search-as-you-type**: each keystroke rescans only the previous one's survivors, sub-millisecond by mid-word even over 100k items.
- **Filter UIs that show every match**: the narrowest result sets of the subsequence engines; a structured query returns a median of 7 rows where Fuse.js ships ~90.
- **Backend one-shot lookups**: build + query costs ~1.5 ms cold over 10k items, so indexing per request is fine.
- **Finding a phrase inside a document**: `fuzzyMatch` scans 16,000 characters in 0.28 ms, and the density floor keeps absent words at exactly 0 false matches.

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
| +0.9  | `transposed`       | adjacent-swap typo, scored as the corrected query's tier + 0.9 |
| > 2   | `fuzzy`            | fuzzy chain (fewer chunks = better)        |

Import `SCORES` for thresholds and `atBest` values; or read `tier` directly:

```typescript
results.filter((r) => r.score <= SCORES.CONTAINS); // drop fuzzy chains and deep rescues
results.filter((r) => r.fields[0]?.tier !== "fuzzy"); // drop fuzzy chains only, categorically
```

`atBest` shifts `score` but never `tier`, so tier filters stay reliable on demoted fields (a body-field prefix hit can report `score: 2.5, tier: "prefix"`).
A rescued transposition can also score above `CONTAINS` (a rescued contains is 2.9) without being a fuzzy chain, so filter by `tier` when you mean the kind of match.

> **Long text:** a fuzzy chain assembled from chunks scattered across a document is junk; unguarded, a word *absent* from the text still "matches" 35% of the time by 512 chars, ~100% by 16k.
> The fuzzy tier refuses any assembly covering less than 18% of its span (measured junk density never exceeds 0.143, the sparsest genuine match is 0.211), which holds the junk rate at **0% at every measured length** with label behaviour unchanged ([the long-text table](./docs/benchmarks.md#matching-inside-long-text)).

> **Acronym semantics:** apostrophes are word-internal: `People's` contributes one initial, `p`, so `lpdr` matches `Lao People's Democratic Republic`.
> Stopwords count too: `Democratic Republic of the Congo` is `drotc`, and `drc` matches nothing (the density floor rejects so sparse a chain).

## The fuzzy tier

Krino ships one opinionated fuzzy mode, always on, with no strategy knob: chunks must start at a word boundary or run 3+ characters (the query's last 1-2 characters are exempt, since a short tail could never satisfy the run rule), and the whole assembly must cover at least 18% of the span it stretches across (the density floor that keeps long text junk-free).
Anything it refuses either matched a higher tier already or wasn't worth showing; filter `tier === "fuzzy"` out of the results if you want literal matches only.

## Comparison

Speed is not the constraint at any realistic size; a prebuilt Krino index answers a 100,000-item query in ~1.3 ms (0.09 ms at 10k), and `fuzzyMatch` over a 16,000-character document costs 0.28 ms.
What separates these libraries is **match quality** and **what you get back**.
Accuracy against the total cost of one cold search (index + one query) — the least flattering ledger for Krino, since a no-index library pays nothing up front (the mixed 10k scorecard from [docs/benchmarks.md](./docs/benchmarks.md); the frontend chart there, query cost only, is a Krino-only frontier):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/pareto-total-dark.svg">
  <img alt="Mixed-corpus accuracy (MRR) vs. total cost of one cold search (index + one query, log scale) as a Pareto frontier. The frontier runs uFuzzy, uFuzzy (latinize), Krino, Krino (acronym); fuzzysort's hidden prepare cache moves it off the frontier, and Fuse.js is dominated: Krino (acronym) scores 0.81 at a 1.5 ms total against Fuse's 0.71 at ~15.7 ms." src="./docs/pareto-total-light.svg">
</picture>

Krino is the only library that by default:

- returns a categorical **`tier`** *and* numeric `ranges`
- folds diacritics
- matches multi-word
- takes per-field config

The full feature matrix, verified per cell against each library's current source, is in [docs/benchmarks.md](./docs/benchmarks.md#libraries).
Originally written for matching in-memory lists on the client, Krino has proven to be a competitive option for serverside work.

### Results, in short

Full method and data live in [docs/benchmarks.md](./docs/benchmarks.md).

- **Match quality**: Krino returns the smallest result set of the subsequence libraries and ranks the source item **first on every structured query**; a one-char slip still matches, and at two dropped chars it returns nothing where its parent returns 135 junk chains.
  An adjacent transposition breaks the subsequence property; Krino's `transposed` tier rescues it (rank 1 with a single row on that probe), leaving substitutions and multi-error typos as the edit-distance engines' remaining edge.
- **Speed** (per-query mean): ~0.1–0.2 ms over 10k items and ~1.3–2.3 ms over 100k, ~6–10× faster than its parent microfuzz; uFuzzy now ties Krino on pure-ascii 100k corpora, while Krino leads accented data outright.
  A prefix-narrowing cache makes typing decay toward sub-millisecond keystrokes.

### What to pick when

**Pick Krino.** It tops the quality scorecard on both benchmark corpora, leads or ties every speed table, and at ~2.6 kB only substring-only `fuzzy` and its parent `microfuzz` undercut it on size.
Two workloads genuinely point elsewhere:

- **Typos beyond adjacent swaps must still match** (user-typed queries over messy data): the `transposed` tier rescues swapped neighbours, but substitutions and multi-error typos need real edit distance. Pick `Fuse.js` (Bitap) or `fast-fuzzy`, at 4–5× the bundle, ~15–37 ms cold queries, and ~90–450-row result sets.
- **Pure-ascii corpora at 100k+, one-shot queries, bare index output is enough**: `uFuzzy` now only ties Krino on raw query speed there, so what remains of this carve-out is its smaller working set and bare-array output, at a fraction of Krino's match quality. Search-as-you-type favours Krino outright: the prefix cache decays keystrokes below uFuzzy's flat per-query cost by the end of a word.

The rest of the field is dominated on these benchmarks; the full argument, per-library, is in [the recommendation](./docs/benchmarks.md#the-recommendation).
(Already on `@nozbe/microfuzz`? Krino is its rebuild: same subsequence approach plus tier, ESM, and 4–8× faster. See [MIGRATION.md](./MIGRATION.md).)

## Building blocks

- `normalizeText(str)`: lowercase, strip diacritics.
- `splitWords(str)`: tokenize on any non-alphanumeric run (keeps `_`).
- `SCORES`: the tier constants.

## Types

```typescript
type Range = [number, number]; // [start, end] inclusive
type Tier =
  | "exact" | "normalized-exact" | "prefix" | "boundary-exact"
  | "boundary" | "multi-word" | "acronym" | "contains"
  | "fuzzy" | "transposed";

type MatchResult = { score: number; tier: Tier; ranges: Range[] };

type FieldSpec<T> = {
  text: (item: T) => string | null;
  acronym?: boolean;     // default false
  atBest?: number;       // shifts this field's scores; its best possible hit ranks here
};

type FuzzyResult<T> = {
  item: T;
  score: number;                       // min effective score across fields
  fields: (MatchResult | null)[];      // one per field spec
};
```

## License

MIT

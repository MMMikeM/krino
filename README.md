# Krino

> Tiny, typed fuzzy matching

- **~2.5 kB** gzip, zero dependencies, TS-first, ESM/CJS
- **0.14 ms** per query over 10k items, ~2 ms over 100k optimised for search-as-you-type
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
- **Finding a phrase inside a document**: `fuzzyMatch` scans 16,000 characters in 0.16 ms, and the density floor keeps absent words at exactly 0 false matches.

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

Import `SCORES` for thresholds and `atBest` values; or read `tier` directly:

```typescript
results.filter((r) => r.score <= SCORES.CONTAINS); // drop fuzzy chains
results.filter((r) => r.fields[0]?.tier !== "fuzzy"); // same, categorically
```

`atBest` shifts `score` but never `tier`, so tier filters stay reliable on demoted fields (a body-field prefix hit can report `score: 2.5, tier: "prefix"`).

> **Long text:** a fuzzy chain assembled from chunks scattered across a document is junk; unguarded, a word *absent* from the text still "matches" 35% of the time by 512 chars, ~100% by 16k.
> The fuzzy tier refuses any assembly covering less than 18% of its span (measured junk density never exceeds 0.143, the sparsest genuine match is 0.211), which holds the junk rate at **0% at every measured length** with label behaviour unchanged ([the long-text table](./docs/benchmarks.md#matching-inside-long-text)).

> **Acronym semantics:** apostrophes are word-internal: `People's` contributes one initial, `p`, so `lpdr` matches `Lao People's Democratic Republic`.
> Stopwords count too: `Democratic Republic of the Congo` is `drotc`, and `drc` matches nothing (the density floor rejects so sparse a chain).

## The fuzzy tier

Krino ships one opinionated fuzzy mode, always on, with no strategy knob: chunks must start at a word boundary or run 3+ characters (the query's last 1-2 characters are exempt, since a short tail could never satisfy the run rule), and the whole assembly must cover at least 18% of the span it stretches across (the density floor that keeps long text junk-free).
Anything it refuses either matched a higher tier already or wasn't worth showing; filter `tier === "fuzzy"` out of the results if you want literal matches only.

## Comparison

Speed is not the constraint at any realistic size; a prebuilt Krino index answers a 100,000-item query in ~2 ms (0.14 ms at 10k), and `fuzzyMatch` over a 16,000-character document costs 0.16 ms.
What separates these libraries is **match quality** and **what you get back**.
Accuracy against per-query cost, indexes prebuilt (the mixed 10k scorecard from [docs/benchmarks.md](./docs/benchmarks.md)):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/pareto-query-dark.svg">
  <img alt="Mixed-corpus accuracy (MRR) vs. query ms with indexes prebuilt, log scale, as a Pareto frontier. The frontier is entirely Krino: from Krino (0.53 at 0.14 ms) to Krino (acronym) (0.57 at 0.16 ms); every other configuration, including Fuse.js at 0.54 and 15 ms, is dominated." src="./docs/pareto-query-light.svg">
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
  Transpositions are the one typo shape subsequence matching cannot represent; only the edit-distance engines surface them, and that trade is priced into their scorecards.
- **Speed** (per-query mean): ~0.2–0.6 ms at 10k and ~2–5 ms at 100k, ~4–8× faster than its parent microfuzz; uFuzzy keeps a ~1.7× lead on pure-ascii 100k+ corpora, while Krino leads accented data at 10k and ties there at 100k.
  A prefix-narrowing cache makes typing decay toward sub-millisecond keystrokes.

### What to pick when

**Pick Krino.** It tops the quality scorecard on both benchmark corpora, leads every speed table except pure-ascii (where only uFuzzy is decisively faster), and at ~2.5 kB only substring-only `fuzzy` and its parent `microfuzz` undercut it on size.
Two workloads genuinely point elsewhere:

- **Typos must still match** (user-typed queries over messy data): a transposition breaks the subsequence property, so no subsequence engine can represent it. Pick `Fuse.js` (Bitap) or `fast-fuzzy` (edit distance), at 4–5× the bundle, ~15–40 ms cold queries, and ~90–450-row result sets.
- **Pure-ascii corpora at 100k+, independent one-shot queries, bare index output is enough**: `uFuzzy` is ~1.7× faster per query there. The lead does not survive search-as-you-type: Krino's prefix cache decays keystrokes below uFuzzy's flat per-query cost by the end of a word, and longer phrases flip the session total. On accented data the lead disappears even per query, and uFuzzy's match quality scores a fraction of Krino's.

The rest of the field is dominated on these benchmarks; the full argument, per-library, is in [the recommendation](./docs/benchmarks.md#the-recommendation).
(Already on `@nozbe/microfuzz`? Krino is its rebuild: same subsequence approach plus tier, ESM, and 4–8× faster. See [MIGRATION.md](./MIGRATION.md).)

## Building blocks

- `normalizeText(str)`: lowercase, strip diacritics.
- `splitWords(str)`: tokenize on any non-alphanumeric run (keeps `_`).
- `matchDensity(ranges)`: matched characters ÷ inclusive span (a junk-chain discriminator).
- `SCORES`: the tier constants.

## Types

```typescript
type Range = [number, number]; // [start, end] inclusive
type Tier =
  | "exact" | "normalized-exact" | "prefix" | "boundary-exact"
  | "boundary" | "multi-word" | "acronym" | "contains" | "fuzzy";

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

# Known issues & feature requests

Found while integrating Krino into a blog search (short curated fields
searched fuzzily, a multi-KB body-vocabulary field searched contains-only).

> **Status (v1.0.0):** all six bugs below are **fixed**, and feature requests
> #1–#5 are **addressed** (see the CHANGELOG). The bug repros in
> `test/known-issues.test.ts` are now passing regression tests. Descriptions and
> suggested fixes are kept below for history.

## Bugs (fixed in v0.2.0)

### 1. Punctuation is not a word boundary

`validWordBoundaries` contains brackets, dashes, and quotes but not
`. , : ; /`, and the word set used by the multi-word tier splits on spaces
only — so `"build,"` never equals `"build"`.

```ts
fuzzyMatch("Fail the build not the runtime", "build runtime"); // score 1.9
fuzzyMatch("Fail the build, not the runtime", "build runtime"); // score 3.2 (!)
fuzzyMatch("foo bar", "bar"); // score 0.9
fuzzyMatch("foo.bar", "bar"); // score 2
```

Any prose with normal punctuation mis-tiers. This is the highest-impact bug:
a single comma demotes a strong multi-word match into the junk-fuzzy tier.

**Suggested fix:** normalize punctuation to spaces in `normalizeText`, or
split the word set on `/[^\p{L}\p{N}_]+/u` and add sentence punctuation to
`validWordBoundaries`. Keep `_` a non-boundary so snake_case identifiers
stay whole words.

### 2. Boundary-contains tier only checks the first occurrence

The tier-0.9/1 check does one `indexOf` and tests the character before that
single occurrence. If the first occurrence is mid-word, a later occurrence
at a real word boundary is never examined.

```ts
fuzzyMatch("actor factor model", "actor"); // score 0.5
fuzzyMatch("factor actor model", "actor"); // score 2 (!) — "actor" is right there
```

**Suggested fix:** walk occurrences (`indexOf` with a moving start) until one
sits at a boundary or the haystack is exhausted.

### 3. Highlight ranges land inside the wrong word

Same `indexOf` habit surfacing in `matches`: the range can point into a
longer word even when the query exists as a standalone word later.

```ts
fuzzyMatch("concatenate the cat", "cat").matches; // [[[3, 5]]] — con[cat]enate
```

Anything rendering highlights underlines the wrong letters. Falls out of the
fix for bug 2. The multi-word tier builds its ranges with bare `indexOf` too
(`"cat"` range found inside `"concatenate"` even when matched as the word).

### 4. Multi-word tier penalises specificity

The score is `1.5 + queryWords.length * 0.2`: every extra word the user
types — narrowing the match — ranks the same item *worse*. Only visible when
the words are scattered (contiguous phrases hit the contains tier first).

```ts
const text = "lag story of the event and the loop";
fuzzyMatch(text, "event loop"); // score 1.9
fuzzyMatch(text, "event loop lag"); // score 2.1 (!) — more specific, worse rank
```

**Suggested fix:** flat 1.5, or subtract per word matched. A three-word
all-present match is never weaker evidence than a two-word one.

### 5. `fuzzyMatch` accepts an empty query

The empty-query guard exists only in `createFuzzySearch` (returns `[]`).
In `fuzzyMatch` the query reaches `normalizedItem.startsWith(normalizedQuery)`,
and `startsWith("")` is always true — so an empty query is reported as a
prefix match with a degenerate range.

```ts
createFuzzySearch(["abc"])(""); // [] — guarded
fuzzyMatch("abc", ""); // score 0.5, matches [[[0, -1]]] (!)
```

**Suggested fix:** early-return `null` from `fuzzyMatch` when the normalized
query is empty, matching `createFuzzySearch`.

### 6. Highlight width uses the raw query length

Tiers 0.9/1/2 build ranges as `[idx, idx + queryLen - 1]` where `queryLen`
is `query.length` — the raw, un-normalized query — but `idx` indexes the
normalized text. Whitespace padding in the query (which `normalizeText`
trims) inflates the width past the actual match.

```ts
fuzzyMatch("Hello World", "wor").matches;   // [[[6, 8]]]
fuzzyMatch("Hello World", " wor ").matches; // [[[6, 10]]] (!) — score still 1
```

Leading whitespace in the *item* shifts ranges the other way, since the
normalized text is shorter than the original the range indexes into.

**Suggested fix:** derive the range width from `normalizedQueryLen`, not the
raw `queryLen`.

## Hazard worth documenting (not a bug)

**Smart fuzzy over long text matches nearly anything.** Chunks only need a
word-boundary start or a 3-char run, so across a few thousand words a short
query almost always assembles a chain: `"zebra"` matches any text containing
`"zero"` and `"branch"`. In an 8-post blog index, `"banana"` matched all 8
posts. The README should scope `smart` to short labels (titles,
names, menu items) and point document-length text at `strategy: "off"`,
which keeps the exact/prefix/boundary/multi-word/contains tiers and drops
only the chain-assembly tier.

Also worth documenting as a guarantee: results with equal scores keep
collection order (`Array.prototype.sort` is stable), so callers can encode a
meaningful default order — e.g. newest-first — in the collection itself.

## Feature requests

> **v1.0.0:** #1 (per-field `fields` + `penalty`), #2 (per-field scores via
> `fields[].score`), #3 (typed `getText`), #4 (exported `SCORES`), and #5
> (`matchDensity`) are all shipped. Originals kept below for reference.

1. **Per-field strategy and weight.** The blog integration wanted "fuzzy on
   title/excerpt/topic, contains-only on body vocabulary, body never
   outranks title". That took two searchers, a manual min-merge, and a +1
   score offset. One searcher could do it:

   ```ts
   createFuzzySearch(posts, {
     fields: [
       { getText: (p) => p.title, strategy: "smart" },
       { getText: (p) => p.words, strategy: "off", weight: 1 }, // added to score
     ],
   });
   ```

2. **Expose per-field scores.** `matches` says which fields matched but
   `score` is only the best across fields, so callers can't weight fields
   themselves. The per-field score is already computed and discarded —
   return `scores: (number | null)[]` alongside `matches`.

3. **Generic options type.** `getText: (item: unknown) => ...` forces an
   `as` cast in every typed codebase. `FuzzySearchOptions<T>` with
   `getText?: (item: T) => Array<string | null>` costs nothing at runtime.

4. **Export tier constants.** Callers filtering by tier hard-code magic
   numbers from the docs (`score <= 2`). Export named bounds, e.g.
   `SCORE_EXACT = 0`, `SCORE_PREFIX = 0.5`, `SCORE_CONTAINS_MAX = 2`, so the
   scoring scheme can evolve without silently breaking downstream filters.

5. **Optional match-density signal for the fuzzy tier.** Chunk count ignores
   spread: five chunks across 20 characters and five across 5 KB score the
   same. Matched-chars ÷ span (from the already-returned ranges) is a cheap
   junk discriminator; exposing it (or folding it into the fuzzy score)
   would let long-text users keep fuzzy on instead of turning it off.

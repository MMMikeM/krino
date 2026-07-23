# Performance notes & exploration

**Status:** mixed — the index analysis is exploration (not on the roadmap); the
pre-filter sections marked DONE are shipped. Recorded so we don't re-derive it.
Started as the analysis behind "should krino index its corpus?"

## The question: a trie index?

On an early **combinatorial** benchmark corpus (`ADJ × NOUN × SUFFIX`), `fast-fuzzy`
benchmarked ~4× faster than krino *while doing typo-tolerant edit-distance matching*.
That looked paradoxical — edit distance is expensive per pair. The trick is
structural, not algorithmic:

1. **Trie index.** `new Searcher(list)` inserts every candidate's normalized key
   into a trie. Shared prefixes are stored — and scored — once.
2. **Threshold-pruned DFS.** It walks the trie running a bounded Sellers /
   Damerau-Levenshtein DP. At each node it computes the *best score any string in
   this subtree could reach*; if that can't clear `threshold` (default 0.6), it
   prunes the whole subtree. Most candidates are never scored.
3. **Rolling DP rows.** Two rows extended along trie edges, so a shared prefix's
   DP cells are computed once for everything beneath it.

So fast-fuzzy is fast **because it indexes + prunes**, not because typos are cheap —
and that speed is **entirely corpus-dependent**. Its pruning only skips subtrees
when candidates share prefixes. When the benchmark corpus was switched to seeded
**faker** data (natural-language product / company / person / place names, far less
shared-prefix structure), fast-fuzzy fell from ~4× faster than krino to **~4–9×
slower** — among the slowest in the set. The trie's whole advantage evaporated with
the corpus shape. (For contrast, Fuse.js is also typo-tolerant and consistently the
slowest here. "Typo-tolerant" says nothing about speed; the data structure and the
corpus do.)

krino, by comparison, does **zero corpus indexing**. `createFuzzySearch` caches
per-field normalization and word splits, but each query then linearly scans *every*
item through the whole tier ladder (exact → prefix → boundary → multi-word →
contains → acronym → fuzzy). O(N) full passes with a fat per-item constant and no
pruning.

## Why a prefix trie is a poor fit for krino specifically

A trie accelerates **prefix** and **exact** lookups. Those are already krino's
cheapest tiers (`startsWith`, `===`). krino's *expensive* tiers match **mid-string
and out-of-order**:

- `boundary` / `contains` — the query can sit anywhere in the field.
- `multi-word` — all query words present in any order.
- `fuzzy` — a subsequence chain scattered across the field.

A prefix trie helps none of these. Worse, fast-fuzzy's pruning relies on a **single
scalar threshold** to cut subtrees. krino has no such cutoff: it's a *tier ladder*
that returns **every** item that matches at any tier, ranked — there's no "score
below X, skip it" to prune on. So the exact mechanism that makes fast-fuzzy's trie
pay off doesn't transfer.

## What would actually help (if we ever target scale)

krino's README already punts on huge corpora ("for 100k+ prefer uFuzzy /
fuzzysort"). If we ever wanted to compete there, the right structures are **not** a
prefix trie:

- **Inverted token index** (`word → items`). Turns the multi-word and
  boundary tiers into posting-list intersections instead of an N-item scan. The
  biggest single lever for those tiers.
- **Trigram (n-gram) index** (`3-gram → items`). Gate the fuzzy/contains tiers by
  shared trigrams *before* the per-item regex subsequence test — prunes the fuzzy
  tier the way the L1 regex gate does, but without visiting every item first.
- **Suffix automaton / suffix array** for arbitrary-substring `contains`. Powerful
  but heavy; likely overkill.

### Costs / tensions

- **Bundle size.** krino is ~2.0 kB (post bitmask gate + dual ESM/CJS build). A
  real index could double that — directly against the "tiny" pitch.
- **Build time + memory.** Index construction (currently ~1–6 ms for 2k–10k) and
  posting-list storage grow with the corpus. Only worth it when N is large.
- **API model.** Any index must live inside `createFuzzySearch` (the stateful,
  cached entry point). The `fuzzyMatch` **primitive must stay stateless** — that's
  the whole point of the primitive-first design. An index that leaked into the
  primitive would break composition.
- **Scope.** At 2k items krino is already <0.2 ms/query; at 10k, ~0.6 ms. Indexing
  buys nothing until the corpus is much bigger than krino's stated target use
  (command palettes, pickers, autocomplete over lists you already hold).

## Cheaper wins

Before any index, the linear scan itself has slack — these keep the current model
and the tiny bundle.

### Front-of-ladder pre-filter — DONE (per query type)

Inspired by uFuzzy, whose speed comes from a single native regex that rejects
non-candidates before any ranking work. krino now does the same at the **front** of
the tier ladder — one native regex that, on failure, skips the whole ladder — with
the gate chosen by query type:

- **Multi-word queries → order-independent presence gate** (`buildPresenceGate`,
  `^(?=[^]*a)(?=[^]*b)…`): asserts every distinct query char is present, in any
  order. This is mandatory here — krino's multi-word tier matches words out of
  order, so uFuzzy's subsequence gate would wrongly reject `"foo bar"` against
  `"bar … foo"`. (Pinned by `bench/correctness.test.ts`.)
- **Single-word queries → subsequence gate** (`buildFuzzyGate`, `a[^]*b[^]*c`): with
  one word there's no out-of-order concern, so every tier needs the query's chars
  *in order*. This gate is both **stricter** (rejects more) and **cheaper** (one
  pass vs the presence gate's k lookaheads).

Both are valid necessary conditions for their query type, so no true match is ever
dropped — all tests stay green.

Measured (seeded faker corpus), original → presence-only → per-type:

| size | no gate | presence gate | per-type gate |
| ---- | ------- | ------------- | ------------- |
| 1k   | 0.093ms | 0.097ms       | **0.073ms**   |
| 10k  | 0.978ms | 0.969ms       | **0.722ms**   |
| 100k | 19.998ms| 11.774ms      | **8.944ms**   |

Net **~2.2× faster at 100k and ~25% at 1k/10k** over the original. The per-type
split also erased the small-corpus regression the always-presence gate caused (its
k-lookahead cost wasn't offset when little is skipped).

### Char-class bitmask pre-gate — DONE (stage 0)

fuzzysort's trick, adopted: a 32-bit character-class mask per field, computed at
build time (`charMask` — a–z on bits 0–25, digits bucketed on 26–29, non-ASCII
bucketed on 30–31; spaces/punctuation skipped so separators are never required of
the field). The query's mask is built once per query;
`(queryMask & fieldMask) !== queryMask` rejects an item with **one integer AND**
before any regex runs. Query and field use the same function, so a bucket
collision can only cause a false *pass* (weaker filter), never a false reject —
asserted per query in `bench/funnel.test.ts` (mask never rejects an item the
full matcher accepts).

Bonus found by the funnel diagnostics: for pure a–z queries the mask *is* an
exact distinct-char presence check, making the multi-word presence regex
redundant — measured cutting **0.0%** after the mask — so it's skipped entirely
(`presenceGateRedundant`).

Measured, same corpus + queries, regex gates only → with bitmask in front:

| size | regex gates | + bitmask   |
| ---- | ----------- | ----------- |
| 1k   | 0.07ms      | **0.04ms**  |
| 10k  | 0.95ms      | **0.39ms**  |
| 100k | 16ms        | **11ms**    |

~2.4× at 10k. The funnel tables (`vitest run funnel.test.ts
--disable-console-intercept`) show the mask alone cutting 55–100% of items per
query and the two stages together cutting 90–100% before any ladder work.

Post-mask standings (two-corpus bench, see below): krino leads its parent
`@nozbe/microfuzz` everywhere on the accented corpus (~2–4×); on ascii at 100k
they converge, with microfuzz's `aggressive` config slightly ahead. Residual gap
to uFuzzy (~2.5–4.5× at scale) is fundamental: krino's survivors run the full JS
tier ladder and build a `tier` + per-char `ranges` + score, and its multi-word
gate is the weaker order-independent kind. The (all opts) bench rows pin this:
uFuzzy with latinize + outOfOrder parity keeps essentially its whole lead —
architecture, not skipped features. krino trades that speed for richer, safer
semantics.

### fieldWords Set removal — DONE (with a stated trade)

The per-field `new Set(splitWords(field))` was build cost and permanent heap: one Set per field, alive for the searcher's lifetime.
`wholeWordOccurrence` replaced it — an `indexOf` walk for an occurrence bounded by non-word characters on both sides, yielding membership *and* position in one pass (which also fixed a latent highlight bug: the old left-bounded range could underline into "catalog" for `"catalog cat"`).
Measured wins: build 0.89 → 0.24 ms at 1k, 7.4 → 3.2 at 10k, 98 → 54 at 100k; and the 100k *query* time fell 13 → 3.4 ms — the Sets' heap was GC and cache pressure on every scan.

**The trade:** multi-word membership went from an O(1) hash hit to an O(field-length) scan per query word.
For krino's target fields (names, labels) the scan beats hashing — no hash, native memchr-style walk.
For document-length fields (`strategy: "off"` body text, which the README supports) it is a theoretical regression that the short-string bench corpus never measures.
Bounded in practice: the bitmask gate rejects most items before any tier runs, the scan stops at the first absent query word, and the tier only fires for multi-word queries that missed every earlier tier.
**Revisit trigger:** a long-field corpus probe showing the multi-word tier dominating query time — the fix would be an opt-in per-field word index for long fields only, not a return of the always-on Set.

### Typed-array union-mask scan — DONE

The per-item union of field masks lives in one `Int32Array`; the reject scan reads 4 bytes per item in a flat walk instead of chasing object properties, and prepared-field objects are only dereferenced by survivors.
The union can only false-pass on multi-field items (some individual field may still miss a class); `matchField`'s per-field mask check keeps multi-field correctness.
Side effect worth keeping: run-to-run variance dropped sharply — the typed-array walk is much steadier than the object walk.

### Prefix-narrowing survivor cache — DONE

The searcher closure remembers the last normalized query and its mask-gate survivor indices; when the new query extends the previous one (the typing case), only those survivors are rescanned.
Correctness rests on a monotonicity argument, documented in the code and pinned by a test: the cache stores the **mask-pass set**, never the match set.
The match set is not monotone under query extension ("the quick brown fox" matches `fox brown` via the multi-word tier while failing `fox brow`); the mask gate is, because extending a query only adds mask bits, so every match of the extended query lies inside the previous mask-pass set.
Backspace and replacement queries fall back to a full scan via the `startsWith` check; a repeated query is idempotent (also pinned by tests).

Measured (100k items, min-of-N): typing 15 keystrokes 178.9 → 27.6 ms, per-keystroke cost decaying 6.1 → 0.5 ms as survivors narrow; nine independent mixed queries 83.5 → 13.2 ms; build ~100 → 19.2 ms cumulative with the earlier build work.
Cost: ~0.1 kB gzip.
Lazy range allocation was considered alongside and deliberately skipped — range building no longer registers as a bottleneck next to these numbers.

### Still on the table

- **Short-circuit ordering** — cheapest, most-selective tiers first (already
  roughly the case).
- **Long-field corpus probe** — the bench corpus is short strings only; a
  document-length field bench would measure the Set-removal trade above and the
  fuzzy-tier hazard on real body text.

## Verdict

**Defer.** A prefix trie is the wrong tool for krino's tier model. Genuine scaling
would come from an inverted-token + trigram index, but that fights the tiny/simple
positioning and only pays off well past krino's target corpus size. Revisit only if
krino deliberately expands to 100k+ corpora; until then, the cheaper scan-level wins
above are the better use of bytes.

## Benchmark caveat (resolved)

The original `bench/compare.bench.ts` built its corpus combinatorially
(`ADJ × NOUN × SUFFIX`), producing **heavy shared prefixes** — ideal conditions for
a trie-based lib like fast-fuzzy. That was fixed: the bench now generates a seeded
**faker** corpus (product / company / person / place names) at 1k / 10k / 100k, which
shares far fewer prefixes. The switch flipped fast-fuzzy from fastest-ish to among
the slowest — concrete proof that corpus shape, not just algorithm, drives these
numbers. Takeaway for any future benchmark: state the corpus, and prefer
natural-language data over word-grids unless prefix-clustering is what you mean to
measure.

## Benchmark hygiene (round 2)

The bench harness grew several honesty mechanisms worth keeping:

- **Two corpora, benched separately.** `ascii` (en faker) and `accented` (fr/pl
  names/places — measured ~33% of items carry a diacritic; the en generators
  measured 0%, and faker's *French company names* also measured 0%, so density
  had to be designed, not assumed). Splitting exposed that diacritics cost
  microfuzz, not krino: microfuzz ties krino on ascii at 100k but loses ~2× on
  accented.
- **"(all opts)" rows.** Every library with opt-ins gets a second bench line
  with everything on (diacritic folding, multi-word, highlight output) except
  typo modes — krino can't reciprocate those. Kills the "fast because it skips
  work" ambiguity in both directions.
- **Sink.** Every bench consumes its results (`sink += r.length`) so the JIT
  can't dead-code-eliminate the work being timed.
- **Match-count + rank validation** (`bench/hits.test.ts`). Every query records
  the corpus item it was derived from; the test reports, per library, how many
  items matched and where that source item ranked (`21 @1`, `959 @315`, `✗`).
  Caught the headline facts: krino v1's `aggressive` mode reproduced microfuzz
  cell-for-cell (that mode *was* the parent's behaviour; `smart` is the change,
  and v2 removed the legacy mode);
  uFuzzy silently returns 0 on accent-stripped queries without `latinize`; typo
  engines rank well but return 3–10× the true hit count.
- **Pass column + corpus-wide mean.** The accented perf table marks configs
  that don't fold diacritics (fast at an easier job), and an *all libraries*
  row pools per-query ms across every config — which showed the two corpora are
  equally hard overall (~0.45 / ~4 / ~43 ms at 1k/10k/100k): diacritics shift
  who pays, not the total.

Takeaway: **verify the matching, then time it.** A speed table over unverified
matchers compares different jobs.

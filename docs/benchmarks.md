# Benchmarks — match quality and speed

Full data behind the README's summary: what each library calls a match, where it ranks the right answer, and what a query costs.
Everything here regenerates from the repo: `pnpm bench && node bench/report.mjs` for the speed tables, `pnpm --filter=krino-bench test` for the match/rank tables ([`bench/hits.test.ts`](../bench/hits.test.ts)) and the pre-filter funnel ([`bench/funnel.test.ts`](../bench/funnel.test.ts)).
Numbers vary per machine.

## What counts as a match?

Same 10,000 items, same query — radically different results (from [`bench/hits.test.ts`](../bench/hits.test.ts)).
Every query is derived from a real corpus item, so each library can be scored on two things separately: **how much it returns** (selectivity — everything below the first few rows is noise someone scrolls past), and **where it ranks the item the query came from** (did the right thing surface).

One small table per query: **rank** = where the item the query was derived from placed (1 = top hit; ✗ = matched other things but lost the source; — = returned nothing), **matches** = how many of the 10,000 items the library returned, **ms** = time-boxed mean of the raw search call at that size (magnitude only — the rigorous timings are the speed tables below).
match-sorter and fuzzy track the microfuzz row throughout; the garbage query `qxzwkv` returns 0 from every library, so it gets no table.
Queries are from the mixed corpus (mostly en faker names with every 7th item from fr/pl generators — ~5% of items carry a diacritic; items are ~97% unique).

### word — `ergonomic`

| Library            | rank | matches |    ms |
|--------------------|-----:|--------:|------:|
| krino (smart)      |    1 |      76 |  0.42 |
| krino (aggressive) |    1 |      76 |  0.39 |
| @nozbe/microfuzz   |    1 |      76 |  1.50 |
| fast-fuzzy         |   13 |      82 |  7.50 |
| Fuse.js            |    1 |      81 | 17.50 |
| fuzzysort          |   20 |      76 |  0.19 |
| uFuzzy             |   29 |      76 |  0.23 |

Everyone agrees on the set (76) — that shared baseline is what makes the speed comparison meaningful.
Rank is the differentiator: krino/microfuzz put the source first; fuzzysort and uFuzzy sink it to 20th–29th.

### two words — `handcrafted wooden`

| Library            | rank | matches |    ms |
|--------------------|-----:|--------:|------:|
| krino (smart)      |    1 |       5 |  0.33 |
| krino (aggressive) |    1 |       5 |  0.40 |
| @nozbe/microfuzz   |    1 |       5 |  1.20 |
| fast-fuzzy         |    1 |      95 |  9.50 |
| Fuse.js            |    1 |      95 | 41.70 |
| fuzzysort          |    1 |       5 |  0.17 |
| uFuzzy             |    2 |       5 |  0.15 |

Five items contain both words; every subsequence library returns exactly those five.
The typo engines return 19× that — and Fuse.js pays ~40 ms for the privilege (its extended-search tokenization is the most expensive path here).

### prefix — `auxen`

| Library            | rank | matches |    ms |
|--------------------|-----:|--------:|------:|
| krino (smart)      |    1 |       1 |  0.32 |
| krino (aggressive) |    1 |       1 |  0.31 |
| @nozbe/microfuzz   |    1 |       1 |  1.30 |
| fast-fuzzy         |    1 |     452 |  7.10 |
| Fuse.js            |    1 |     444 | 12.70 |
| fuzzysort          |    1 |       1 |  0.16 |
| uFuzzy             |    1 |       1 |  0.21 |

One item matches this prefix; every subsequence library returns exactly it.
The typo engines return ~450 candidates for that one true hit — recall-through-noise at its starkest.

### the fuzzy limit — `genric` / `geerc` / `gnrc`

Three probes degrade one source word ("Generic") in steps: **light** drops one middle char (`genric` — a sloppy keystroke), **medium** drops every third char (`geerc`), **heavy** keeps only every other char (`gnrc` — 1–2 char fragments).
Where a library stops surfacing the source is its effective fuzzy limit.

**light — `genric`:**

| Library            | rank | matches |    ms |
|--------------------|-----:|--------:|------:|
| krino (smart)      |    9 |      80 |  0.47 |
| krino (aggressive) |    9 |     116 |  0.49 |
| @nozbe/microfuzz   |    9 |     116 |  1.10 |
| fast-fuzzy         |   73 |     252 |  7.20 |
| Fuse.js            |    9 |     246 | 11.90 |
| fuzzysort          |   74 |     116 |  0.24 |
| uFuzzy             |    — |       0 |  0.19 |

**medium — `geerc`:**

| Library            | rank | matches |    ms |
|--------------------|-----:|--------:|------:|
| krino (smart)      |    — |       0 |  0.57 |
| krino (aggressive) |    9 |     135 |  0.52 |
| @nozbe/microfuzz   |    9 |     135 |  1.10 |
| fast-fuzzy         |  140 |     495 |  7.30 |
| Fuse.js            |  219 |     486 | 10.80 |
| fuzzysort          |   77 |     135 |  0.24 |
| uFuzzy             |    — |       0 |  0.17 |

**heavy — `gnrc`:**

| Library            | rank | matches |   ms |
|--------------------|-----:|--------:|-----:|
| krino (smart)      |    — |       0 | 0.47 |
| krino (aggressive) |   32 |     187 | 0.45 |
| @nozbe/microfuzz   |   32 |     187 | 1.00 |
| fast-fuzzy         |    ✗ |      22 | 5.50 |
| Fuse.js            |    ✗ |      22 | 6.50 |
| fuzzysort          |   74 |     187 | 0.21 |
| uFuzzy             |    — |       0 | 0.18 |

The gradient locates each engine's limit.
krino's `smart` handles the realistic case — one dropped char — with the smallest result set, then refuses outright at two gaps: its chunking demands word boundaries or 3+ char runs, and returning nothing beats returning 135 junk chains.
`strategy: "aggressive"` never gives up — and reproduces microfuzz exactly at every level: that mode *is* the parent library's behaviour, `smart` is what krino changed.
The typo engines degrade noisily (rank 73 → 140 → lost, with 2–4× the matches); fuzzysort accepts everything but ranks the source ~75th throughout.
uFuzzy's default tolerates no intra-word gaps at all — 0 at every level.

### accents — `kepa`

| Library            | rank | matches |   ms |
|--------------------|-----:|--------:|-----:|
| krino (smart)      |    2 |       8 | 0.47 |
| krino (aggressive) |    2 |      70 | 0.39 |
| @nozbe/microfuzz   |    2 |      70 | 0.96 |
| fast-fuzzy         |   33 |      82 | 6.50 |
| Fuse.js            |    1 |      74 | 7.10 |
| fuzzysort          |    2 |      70 | 0.18 |
| uFuzzy             |    — |       0 | 0.19 |

`kepa` targets items containing "Kępa".
uFuzzy's 0 is the silent diacritics miss the Pass column flags — its opt-in `latinize` config finds 4.
fast-fuzzy's 82 come from edit distance, not folding — the source lands at rank 33.

### Scorecard

One line per configuration, computed by [`bench/hits.test.ts`](../bench/hits.test.ts) over the tables above.
**MRR** = mean reciprocal rank of the source item across the 8 scored queries (mean of `1/rank`, miss = 0) — the principled "average rank": bounded, no invented rank for misses, deep ranks self-dampen.
**median matches** is its mandatory companion — MRR alone crowns whoever returns everything, and Fuse.js tops it precisely by shipping ~170-row result lists.
**mean ms** = time-boxed mean of the raw search call across all 9 queries.

| Library            |  MRR | median matches | mean ms |
|--------------------|-----:|---------------:|--------:|
| Fuse.js            | 0.64 |            171 |   19.70 |
| Fuse.js (all opts) | 0.64 |            164 |   17.40 |
| krino (aggressive) | 0.59 |             73 |    0.43 |
| @nozbe/microfuzz   | 0.59 |             73 |    1.20 |
| krino (smart)      | 0.58 |              7 |    0.41 |
| fuzzy              | 0.53 |             71 |    3.40 |
| fuzzysort          | 0.39 |             73 |    0.20 |
| fast-fuzzy         | 0.33 |            174 |    7.70 |
| uFuzzy (latinize)  | 0.30 |              3 |    0.18 |
| match-sorter       | 0.29 |             73 |    3.00 |
| uFuzzy             | 0.25 |              1 |    0.20 |

Read as pairs: Fuse.js buys 0.64 with 170-row lists at ~20 ms; krino's `smart` scores 0.58 returning a median of **7** items in 0.41 ms.
Same MRR neighbourhood, 25× less noise, 50× less time.

## Size, speed & search type

Positioning, not a leaderboard.
One uniform method.
**Gzip** = esbuild `--bundle --minify` + gzip, tree-shaken to each lib's primary API (see the Libraries table).
Each list size gets two columns: per-query mean ms, and **rel** = time relative to krino (100% = same, lower = faster).
**Pass** (mixed table) = the configuration folds diacritics, i.e. actually does that corpus's task — cross-checked per query by [`bench/hits.test.ts`](../bench/hits.test.ts); a fast row that doesn't pass is fast at a different, easier job.
The ***all libraries*** row is the corpus-wide view: mean ± sd of per-query ms pooled across every configuration at that size.
Two seeded faker corpora, benched separately: **ascii** (en locale — effectively no diacritics) and **mixed** (mostly en with every 7th item from fr/pl generators — ~5% of items carry a diacritic, a realistic international dataset; items are ~97% unique, faker repeats a few names).
**(all opts)** rows switch on every opt-in the library has — diacritic folding, multi-word, highlight/ranges output — except typo modes, which stay off everywhere (krino can't reciprocate); base rows are stock defaults.
Benches consume every result into a sink (no dead-code elimination), and [`bench/hits.test.ts`](../bench/hits.test.ts) records per-library match counts for every query — timing is only comparable because the matching is verified.
Full precision (including per-cell sd) + method are in [`bench/comparison.json`](../bench/comparison.json); regenerate with `pnpm bench && node bench/report.mjs`.
**Numbers vary per machine** — a sd rivalling its mean flags a noisy cell, not a stable result.
Grouped by type; within a type, sorted by size.

### Libraries

Sorted by bundle size in comparison to Krino

| Library          | Gzip    | Deps | Type                 |
|------------------|---------|------|----------------------|
| **krino**        | ~2.0 kB | 0    | subsequence (tiered) |
| fuzzy            | ~0.8 kB | 0    | substring            |
| @nozbe/microfuzz | ~1.7 kB | 0    | subsequence          |
| match-sorter     | ~3.4 kB | 2    | subsequence (tiered) |
| fuzzysort        | ~3.7 kB | 0    | subsequence          |
| uFuzzy           | ~4.1 kB | 0    | subsequence          |
| Fuse.js          | ~9.3 kB | 0    | typo-tolerant        |
| fast-fuzzy       | ~11 kB  | 1    | typo-tolerant        |

An "(all opts)" row in the corpus tables shares its base library's size, deps, and type.

### ascii corpus

| Library                     |       1k ms |   1k rel |      10k ms |  10k rel |       100k ms | 100k rel |
|:----------------------------|------------:|---------:|------------:|---------:|--------------:|---------:|
| **krino**                   |        0.06 | **100%** |        0.61 | **100%** |         12.00 | **100%** |
| krino (all opts)            |        0.06 |      99% |        0.75 |     123% |         13.00 |     110% |
| match-sorter                |        0.26 |     460% |        2.70 |     438% |         29.00 |     241% |
| @nozbe/microfuzz            |        0.12 |     202% |        1.30 |     206% |         13.00 |     108% |
| @nozbe/microfuzz (all opts) |        0.12 |     209% |        1.10 |     187% |         12.00 |     100% |
| fuzzysort                   |        0.02 |      31% |        0.30 |      49% |         14.00 |     116% |
| uFuzzy                      |        0.02 |      30% |        0.22 |      36% |          2.80 |      24% |
| uFuzzy (all opts)           |        0.02 |      30% |        0.22 |      36% |          2.70 |      23% |
| fast-fuzzy                  |        0.67 |    1173% |        5.80 |     949% |         59.00 |     494% |
| fast-fuzzy (all opts)       |        0.66 |    1153% |        6.20 |    1015% |         66.00 |     554% |
| Fuse.js                     |        1.30 |    2273% |       13.00 |    2134% |        143.00 |    1208% |
| Fuse.js (all opts)          |        1.50 |    2646% |       15.00 |    2484% |        165.00 |    1394% |
| fuzzy                       |        0.23 |     404% |        2.10 |     335% |         22.00 |     184% |
| fuzzy (all opts)            |        0.25 |     430% |        2.10 |     348% |         23.00 |     195% |
| *all libraries*             | 0.38 ± 0.47 |        — | 3.70 ± 4.70 |        — | 41.00 ± 50.00 |        — |

### mixed corpus

| Library                     |       1k ms |   1k rel |   10k    ms |  10k rel |   100k     ms | 100k rel | Pass |
|-----------------------------|------------:|---------:|------------:|---------:|--------------:|---------:|:----:|
| **krino**                   |        0.08 | **100%** |        0.38 | **100%** |         13.00 | **100%** |  ✅   |
| krino (all opts)            |        0.05 |      66% |        0.41 |     107% |          9.50 |      73% |  ✅   |
| match-sorter                |        0.30 |     373% |        2.90 |     749% |         33.00 |     250% |  ✅   |
| @nozbe/microfuzz            |        0.13 |     161% |        1.10 |     281% |         26.00 |     197% |  ✅   |
| @nozbe/microfuzz (all opts) |        0.10 |     125% |        1.10 |     292% |         21.00 |     163% |  ✅   |
| fuzzysort                   |        0.03 |      31% |        0.27 |      72% |         11.00 |      84% |  ✅   |
| uFuzzy                      |        0.02 |      28% |        0.20 |      54% |          4.90 |      37% |  ➖   |
| uFuzzy (all opts)           |        0.02 |      30% |        0.20 |      54% |          3.00 |      23% |  ✅   |
| fast-fuzzy                  |        0.95 |    1169% |        6.80 |    1792% |         58.00 |     447% |  ➖   |
| fast-fuzzy (all opts)       |        1.40 |    1724% |        6.40 |    1679% |         64.00 |     493% |  ➖   |
| Fuse.js                     |        1.80 |    2187% |       14.00 |    3642% |        142.00 |    1091% |  ➖   |
| Fuse.js (all opts)          |        1.60 |    1947% |       16.00 |    4078% |        170.00 |    1305% |  ✅   |
| fuzzy                       |        0.25 |     308% |        2.50 |     663% |         30.00 |     234% |  ➖   |
| fuzzy (all opts)            |        0.25 |     301% |        2.60 |     688% |         32.00 |     247% |  ➖   |
| *all libraries*             | 0.50 ± 0.62 |        — | 3.90 ± 4.90 |        — | 44.00 ± 49.00 |        — |  —   |

➖ in Pass = does not fold diacritics in this configuration — silently misses accented matches, so its time is for doing less of the task.
Measured, not assumed: on the accent-probe query `kepa` (from "Kępa…") at 10k, base uFuzzy finds **0** matches where its folding (all opts) config finds 4 and krino 8 ([`bench/hits.test.ts`](../bench/hits.test.ts)).
uFuzzy/Fuse.js fold in their (all opts) rows; fast-fuzzy and fuzzy have no folding option at all.

## Reading the speed numbers

At 1k everything is invisible; speed only starts to matter past ~10k.
A two-stage pre-filter skips the tier ladder for non-candidates — an O(1) char-class bitmask per item (fuzzysort-style), then a native regex gate (subsequence for single-word queries, char-presence for multi-word) — cutting 90–100% of items before any ladder work on these corpora.
krino beats its parent `@nozbe/microfuzz` at every size on the mixed corpus (1.6–2.8×) and at 1k/10k on ascii (~2×); at ascii-100k the two converge.
The (all opts) rows stay cheap in absolute terms across the board.
uFuzzy with diacritic folding, out-of-order matching, and cached-latinized haystack keeps essentially its whole lead, so its advantage is architecture, not skipped features.
Cross-*type* speed isn't apples-to-apples: **typo-tolerant** libs (Fuse.js, fast-fuzzy) do far more work; the fast **subsequence** libs (uFuzzy, fuzzysort) do less per match — no diacritic folding / tiers / multi-word by default — so they lead.
uFuzzy in particular is a single native-regex filter that ranks only survivors, where krino runs a full tier ladder and builds a `tier` + per-character `ranges` per match — richer output, more work; the residual gap is that trade, not overhead we can gate away.
**fast-fuzzy is corpus-sensitive**: its trie shines on shared-prefix data but this natural-language corpus prunes less, dropping it among the slowest (on a combinatorial word-grid it was ~4× *faster* than krino — corpus shape moves these numbers a lot).
For 100k+ corpora, prefer `uFuzzy` or `fuzzysort`.
Preprocessing is cached in `createFuzzySearch` (build once, query many).

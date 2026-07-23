# Benchmarks: match quality and speed

Full data behind the README's summary: what each library calls a match, where it ranks the right answer, and what a query costs.
Everything here regenerates from the repo:

- `pnpm bench && node bench/report.mjs` — the speed tables
- `node bench/scorecard.mjs` — the scorecard (5 fresh processes, medianed)
- `pnpm --filter=krino-bench test` — the match/rank tables ([`bench/hits.test.ts`](../bench/hits.test.ts)) and the pre-filter funnel ([`bench/funnel.test.ts`](../bench/funnel.test.ts))

Scope a dev run to one table with `BENCH=mixed-10k pnpm bench` (tokens: a corpus, a size, or `corpus-size`, comma-separable); scoped runs skip `results.json` so they can't clobber the published matrix, which always comes from a full run.
The corpora are frozen JSON snapshots (`bench/corpus-*.json`), so runs pay no generation cost and the data can't drift when faker changes between versions; regenerating them is a deliberate act ([`bench/corpus-gen.test.ts`](../bench/corpus-gen.test.ts)) that rewrites history for every rank table here.
Improvements to the benchmarks are welcome.

## Before matching: the index

Every query number in this document times a **prebuilt** searcher, so the first question is what building one costs, and where each library hides its preparation.
There are three ledgers: **eager** (krino and fast-fuzzy build their structures up front; Fuse.js nominally sits here too, but its trivial index defers the real work to query time), **lazy** (microfuzz defers part of its preparation to the first search — its own docs: "the first search takes ~7 ms, subsequent under 1.5 ms" — and fuzzysort quietly does the same, preparing every string target on the first `go()` and caching them process-wide, ~87× the cost of a steady query at 10k; the Scorecard prices both slices into the **index** column — microfuzz as build + first search − one steady search, fuzzysort as an explicit prepare-all pass — while the build table below times only eager work), and **none** (uFuzzy, match-sorter, and fuzzy genuinely keep no state; their preparation runs inside every single query below, and their first-call overhead is plain JIT warmup, which the harness's warm pass owes every library equally).
Same bill, three different places to pay it, which is why per-query numbers alone can't rank these libraries.

| build |    krino | @nozbe/microfuzz | fast-fuzzy | Fuse.js |
|-------|---------:|-----------------:|-----------:|--------:|
| 10k   |  1.86 ms |         16.38 ms |   30.96 ms | 1.31 ms |
| 100k  | 51.13 ms |        148.17 ms |  547.77 ms | 7.95 ms |

Measured on the mixed corpus; build cost barely differs between corpora.
One caveat on the cells themselves: they are vitest bench **means**, not medians.
Building an index is allocation-heavy (per-item strings, objects, and arrays), and the harness runs builds back-to-back with no idle time, so the garbage collector fires *during* the timed iterations and its pauses land in the mean.
The distortion grows with allocation rate and list size, and at 100k it is visible in the ratios: krino's 10k→100k step is 27× (1.86 → 51.13) where microfuzz's is 9× and Fuse's is 6× — nothing in krino's build is superlinear; measured standalone (best-of-N, GC quiet) its 100k build floors at ~13–20 ms, roughly 2–4× below its cell.
Relative rankings survive — every library runs under the same harness, and the allocation-heavy builds are penalized together — but read the absolute cells as harness-conditioned ceilings, not steady-state costs.
Fuse.js's near-free build is the flip side of its slow queries: its "index" is trivial and the work is deferred to query time.
fast-fuzzy's trie is the opposite trade: the heaviest build in the set buys its subtree pruning.
krino prepares eagerly, so a 100k list swap costs ~51 ms once; keystrokes then ride the prefix cache — ~6 ms cold at the 3-char gate, sub-millisecond by the end of the word (see the session table at the bottom).
On a frontend the index is paid once at load and amortized across every keystroke; for a backend one-shot search over fresh data, index + one query is the real cost; the Scorecard below reports **index**, **query**, and **total** separately so both readings stay available.

## What counts as a match?

Each library has its own definition of a match, so raw outputs aren't directly comparable.
To surface the differences, each query below runs against the same 10,000 items in every library.
The corpus is generated with [Faker](https://github.com/faker-js/faker) (see the frozen snapshots above).

This way each library can be scored:

   1. **Where it ranks the queried item.**
      In most cases, a deep rank is effectively a miss, particularly in a UI, so a rank outside the top 10 counts as a miss.
      Scoring uses the mean reciprocal rank (average of `1/rank`), **MRR** from here on, a bounded score ranging from 0 to 1.
      A rank 1 match gets a score of 1, rank 2 gets 0.5, rank 5 gets 0.2 and rank 10 gets 0.1; a rank outside the top 10, like a miss, gets 0.
   2. **How many items it returns.**
      This is reported as a *diagnostic*, not a score. If 50% of the corpus is returned as a potential match, it's easy to guarantee that the true match exists.
      However this is not a meaningful quality axis: any ranked list can be sliced to the top N, many of these libraries even provide a limit or threshold option. Junk results cost nothing if they're never considered.
   3. **The duration taken to run the query.**
      The absolute numbers look harmless — even at 100k, pooled across every library, the average query stays under 50 ms — but the spread behind that average is three orders of magnitude (0.04 ms to ~44 ms on the same 10k query below), and the workload multiplies it: search-as-you-type runs a query per keystroke, where that spread is the difference between a budget nobody notices and one that eats the frame.

One small table per query: **rank** = where the item the query was derived from placed (1 = top hit; ✗ = matched other things but lost the source; — = returned nothing), **matches** = how many of the 10,000 items the library returned.
**query ms** = time-boxed median of the raw search call against the *prebuilt* searcher; **total ms** = query + the configuration's one-time index cost, the honest cold one-shot number.
("Total" approximates the *first* query from cold, yet its query addend is a steady-state call, not a literal first call — deliberately: every one-time cost sits in the index column, including microfuzz's lazy first-search slice, so timing a real first call would double-count the preparation.)
The two are equal for libraries that keep no index (their preparation runs inside every query), which is exactly why a single time column would be dishonest: it would compare krino's warm query against uFuzzy's entire workload.
fuzzysort looks index-free but isn't — its first `go()` prepares and caches every target — so its total carries that hidden index like the true index builders (see the ledger paragraph up top).
Magnitude only; the rigorous timings are the speed tables below. Regenerate with `node bench/tables.mjs` after a hits run.
Two scorecard libraries are left out of the per-query tables to keep them readable.
fuzzy behaves like a less capable microfuzz: identical ranks on the plain-word, two-word, prefix, and light-typo probes; it drifts on the deep-typo and acronym probes and misses the accent probe outright (no folding).
match-sorter never places best on any query — some shown library always matches or beats it.
Both keep full per-query cells in [`bench/scorecard-run.json`](../bench/scorecard-run.json).
The garbage query `qxzwkv` returns 0 from every library, so it gets no table either.
Queries are from the mixed corpus (mostly en faker names with every 7th item from fr/pl generators, ~5% of items carry a diacritic; items are ~97% unique).

### word: `ergonomic`

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    1 |      76 |     0.11 |     1.70 |
| krino (acronym)    |    1 |      76 |     0.09 |     1.60 |
| @nozbe/microfuzz   |    1 |      76 |     1.15 |     8.96 |
| fast-fuzzy         |   13 |      82 |     7.63 |    45.72 |
| Fuse.js            |    1 |      81 |    16.67 |    17.46 |
| fuzzysort          |   20 |      76 |     0.14 |     7.14 |
| uFuzzy             |   29 |      76 |     0.22 |     0.22 |

The subsequence libraries agree on the set (76); the typo engines add a handful (81–82). That near-shared baseline is what makes the speed comparison meaningful.
Rank is the differentiator: krino/microfuzz put the source first; fuzzysort and uFuzzy sink it to 20th–29th.

### second word: `grady`

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    1 |      19 |     0.09 |     1.68 |
| krino (acronym)    |    1 |      19 |     0.10 |     1.61 |
| @nozbe/microfuzz   |    1 |      36 |     0.94 |     8.75 |
| fast-fuzzy         |    2 |     382 |     6.47 |    44.55 |
| Fuse.js            |    1 |     375 |    10.98 |    11.77 |
| fuzzysort          |    2 |      36 |     0.13 |     7.14 |
| uFuzzy             |    2 |      19 |     0.20 |     0.20 |

A second plain-word probe from elsewhere in the corpus; same shape as the first: krino ranks the source first with the smallest set (`smart` returns 19 where the typo engines return ~380).

### two words: `handcrafted wooden`

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    1 |       5 |     0.05 |     1.64 |
| krino (acronym)    |    1 |       5 |     0.06 |     1.57 |
| @nozbe/microfuzz   |    1 |       5 |     1.03 |     8.83 |
| fast-fuzzy         |    1 |      95 |     8.86 |    46.95 |
| Fuse.js            |    1 |      95 |    40.19 |    40.98 |
| fuzzysort          |    1 |       5 |     0.11 |     7.12 |
| uFuzzy             |    2 |       5 |     0.14 |     0.14 |

Five items contain both words; every subsequence library returns exactly those five.
The typo engines return 19× that, and Fuse.js takes ~40 ms to do it (its extended-search tokenization is the most expensive path here).

### prefix: `auxen`

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    1 |       1 |     0.04 |     1.63 |
| krino (acronym)    |    1 |       1 |     0.04 |     1.54 |
| @nozbe/microfuzz   |    1 |       1 |     1.08 |     8.88 |
| fast-fuzzy         |    1 |     452 |     8.65 |    46.74 |
| Fuse.js            |    1 |     444 |    11.00 |    11.79 |
| fuzzysort          |    1 |       1 |     0.10 |     7.11 |
| uFuzzy             |    1 |       1 |     0.23 |     0.23 |

One item matches this prefix; every subsequence library returns exactly it.
The typo engines return ~450 candidates for that one true hit.

### the fuzzy limit: `genric` / `geerc` / `gnrc`

Three probes degrade one source word ("Generic") in steps: **light** drops one middle char (`genric`, a sloppy keystroke), **medium** drops every third char (`geerc`), **heavy** keeps only every other char (`gnrc`, 1–2 char fragments).
Where a library stops surfacing the source is its effective fuzzy limit.

**light (`genric`):**

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    9 |      80 |     0.17 |     1.77 |
| krino (acronym)    |    9 |      80 |     0.22 |     1.73 |
| @nozbe/microfuzz   |    9 |     116 |     0.93 |     8.73 |
| fast-fuzzy         |   73 |     252 |     6.50 |    44.58 |
| Fuse.js            |    9 |     246 |    11.78 |    12.57 |
| fuzzysort          |   74 |     116 |     0.17 |     7.18 |
| uFuzzy             |    — |       0 |     0.15 |     0.15 |

**medium (`geerc`):**

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    — |       0 |     0.23 |     1.82 |
| krino (acronym)    |    — |       0 |     0.27 |     1.78 |
| @nozbe/microfuzz   |    9 |     135 |     0.93 |     8.74 |
| fast-fuzzy         |  140 |     495 |     6.26 |    44.35 |
| Fuse.js            |  219 |     486 |    10.88 |    11.68 |
| fuzzysort          |   77 |     135 |     0.20 |     7.21 |
| uFuzzy             |    — |       0 |     0.18 |     0.18 |

**heavy (`gnrc`):**

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    — |       0 |     0.20 |     1.79 |
| krino (acronym)    |    — |       0 |     0.26 |     1.77 |
| @nozbe/microfuzz   |   32 |     187 |     0.95 |     8.75 |
| fast-fuzzy         |    ✗ |      22 |     5.19 |    43.28 |
| Fuse.js            |    ✗ |      22 |     7.05 |     7.84 |
| fuzzysort          |   74 |     187 |     0.22 |     7.22 |
| uFuzzy             |    — |       0 |     0.18 |     0.18 |

The gradient locates each engine's limit.
krino's `smart` handles the realistic case (one dropped char) with the smallest result set, then refuses outright at two gaps: its chunking demands word boundaries or 3+ char runs, and returning nothing beats returning 135 junk chains.
microfuzz keeps matching at every level — the behaviour krino inherited and then changed; `smart`'s refusal *is* the change (krino v1 kept the parent's mode as `strategy: "aggressive"`; v2 removed it).
The typo engines degrade noisily — fast-fuzzy slides 73 → 140 → lost, Fuse.js falls 9 → 219 → lost, both with 2–4× the matches; fuzzysort accepts everything but ranks the source ~75th throughout.
uFuzzy's default tolerates no intra-word gaps at all, 0 at every level.

### acronym: `rsaw`

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    2 |       8 |     0.21 |     1.80 |
| krino (acronym)    |    1 |       8 |     0.26 |     1.77 |
| @nozbe/microfuzz   |    2 |     133 |     1.12 |     8.93 |
| fast-fuzzy         |    ✗ |      28 |     5.30 |    43.39 |
| Fuse.js            |    ✗ |      28 |     7.13 |     7.92 |
| fuzzysort          |    2 |     133 |     0.19 |     7.20 |
| uFuzzy             |    — |       0 |     0.19 |     0.19 |

`rsaw` is the initials of "Rath, Streich and Witting".
krino's opt-in acronym tier ranks the source **first** with a tight set of 8, while smart/microfuzz/fuzzysort land it second (the chain engines by matching 133 scattered subsequences, smart via single-char word-boundary chunks).
The typo engines lose the source entirely (✗); uFuzzy's defaults find nothing.
Tier semantics: apostrophes are word-internal (`People's` contributes one initial, `p`), and stopwords are not skipped (`drc` won't acronym-match "Democratic Republic of the Congo"; it still surfaces via the fuzzy tier).

### accents: `kepa`

| Library            | rank | matches | query ms | total ms |
|--------------------|-----:|--------:|---------:|---------:|
| krino (smart)      |    2 |       8 |     0.10 |     1.69 |
| krino (acronym)    |    2 |       8 |     0.13 |     1.64 |
| @nozbe/microfuzz   |    2 |      70 |     0.95 |     8.76 |
| fast-fuzzy         |   33 |      82 |     5.38 |    43.47 |
| Fuse.js            |    1 |      74 |     7.01 |     7.80 |
| fuzzysort          |    2 |      70 |     0.14 |     7.15 |
| uFuzzy             |    — |       0 |     0.19 |     0.19 |

`kepa` targets items containing "Kępa".
uFuzzy's 0 is the silent diacritics miss that gets its base config omitted from the mixed speed table. Its opt-in `latinize` config finds 4.
fast-fuzzy's 82 come from edit distance rather than folding, and the source lands at rank 33.

### Scorecard

One line per configuration, computed by [`bench/hits.test.ts`](../bench/hits.test.ts) over the tables above; the published numbers come from `node bench/scorecard.mjs`, which medians 5 fresh benchmark processes.
**MRR** = mean reciprocal rank of the source item across the 9 scored queries, with the top-10 cutoff from "What counts as a match?": misses and ranks outside the top 10 score 0.
**index ms** = the one-time cost of building the searcher (— for libraries that keep no index; their preparation runs inside every query).
**query ms** = per-query cost averaged across all 10 queries.
**total ms** = index + one query, the cold-start cost.
Which column matters depends on workload (see "Before matching: the index"): frontend → **query**; backend one-shot → **total**.
Three ledger notes: microfuzz's lazy prep is priced into its index cell as time-to-ready — build + first search, minus one steady-state search of the same query so the cell isolates preparation (index = build + first − second); fuzzysort's index cell times an explicit prepare-all pass, the work its first `go()` performs lazily and caches process-wide; uFuzzy (latinize)'s index is latinizing the haystack, real preparation that normally hides as "no index".
The published values are **medians, not means**. Timing noise is one-sided (GC, scheduler, and thermal interruptions only ever *add* time), so a mean absorbs the spikes while a median rejects them: within a run each cell is the median of ~100 ms of individually-timed, cache-busted calls (see `timeQuery` in the test), and the published value is the median across the 5 processes, which also cancels process-level drift (JIT tier-up, thermals, background load).
**mixed corpus** (the query set above):

| Library            |  MRR | index ms | query ms | total ms |
|--------------------|-----:|---------:|---------:|---------:|
| krino (acronym)    | 0.62 |     1.58 |     0.14 |     1.72 |
| @nozbe/microfuzz   | 0.58 |     7.81 |     0.99 |     8.79 |
| krino (smart)      | 0.57 |     1.44 |     0.12 |     1.56 |
| Fuse.js            | 0.57 |     0.79 |    13.36 |    14.15 |
| Fuse.js (all opts) | 0.57 |     0.79 |    16.59 |    17.38 |
| fuzzy              | 0.46 |        — |     2.33 |     2.33 |
| fuzzysort          | 0.39 |     7.01 |     0.16 |     7.17 |
| match-sorter       | 0.31 |        — |     2.85 |     2.85 |
| fast-fuzzy         | 0.28 |    38.09 |     6.60 |    44.69 |
| uFuzzy (latinize)  | 0.26 |     0.59 |     0.17 |     0.77 |
| uFuzzy             | 0.22 |        — |     0.18 |     0.18 |

**ascii corpus** (its own query set over its own corpus — down to its own accent probe, `cote` from "Côte d'Ivoire", which the en locale emits — so MRRs aren't comparable across corpora):

| Library            |  MRR | index ms | query ms | total ms |
|--------------------|-----:|---------:|---------:|---------:|
| krino (acronym)    | 0.61 |     1.15 |     0.36 |     1.52 |
| @nozbe/microfuzz   | 0.56 |     7.29 |     1.04 |     8.33 |
| krino (smart)      | 0.54 |     1.32 |     0.29 |     1.61 |
| fuzzy              | 0.39 |        — |     1.81 |     1.81 |
| Fuse.js            | 0.33 |     0.82 |    12.57 |    13.39 |
| Fuse.js (all opts) | 0.33 |     0.82 |    16.04 |    16.85 |
| match-sorter       | 0.23 |        — |     2.67 |     2.67 |
| fuzzysort          | 0.18 |     6.58 |     0.25 |     6.83 |
| fast-fuzzy         | 0.16 |    38.27 |     8.36 |    46.63 |
| uFuzzy             | 0.15 |        — |     0.18 |     0.18 |
| uFuzzy (latinize)  | 0.15 |     0.55 |     0.18 |     0.73 |

Result-set size is deliberately **not** a scorecard column: in a ranked UI any result list slices to the top N, so a large return costs a picker nothing (see "What counts as a match?").
The per-query tables above keep the raw counts for the two places size does matter: filter-style UIs that show every match, and telling whether an MRR came from a selective matcher or from ranking a huge candidate set.
**krino (acronym) tops both corpora outright** (0.62 mixed / 0.61 ascii): only a deliberate acronym tier ranks initials first, while Fuse.js *loses the source* on that query and lands at 0.57, arriving with ~90-row median lists (mean ~185) at ~13 ms where krino's answer costs 0.14 ms.
On structured queries krino returns a median of **7** rows where Fuse ships ~90, indistinguishable to a picker, decisive for a filter.
The same lens explains microfuzz edging krino (smart) on raw MRR (0.58 vs 0.57 mixed, 0.56 vs 0.54 ascii): MRR can't see result-set size, and the parent's edge is the deep-typo probes, where smart returns nothing and microfuzz returns junk that happens to contain the source (0 vs 135 rows on `geerc`) — alongside 2–17× the rows everywhere else (36 vs 19 on `grady`, 133 vs 8 on `rsaw`).
That refusal is krino's deliberate change to the parent's matcher, not a capability gap; see "the fuzzy limit" above.
(Scorecard timing busts krino's prefix cache between samples; an identical repeated query would otherwise time the survivor-rescan path while every other library pays a cold scan; see `timeQuery` in [`bench/hits.test.ts`](../bench/hits.test.ts).)

The scorecard's cost columns are exactly what the charts draw, one per ledger.

**Frontend ledger:** the index is built once at load, so keystrokes pay query only. Both charts draw the mixed 10k scorecard; on this ledger its frontier is *entirely krino* (smart to acronym) and every other configuration, Fuse.js included, is dominated (on ascii, uFuzzy's raw speed would put it on the frontier, at a far lower MRR):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./pareto-query-dark.svg">
  <img alt="Mixed-corpus accuracy (MRR) vs. query ms with indexes prebuilt, log scale, as a Pareto frontier. The frontier is entirely krino: smart (0.57 at 0.12 ms) to acronym (0.62 at 0.14 ms); every other configuration, including Fuse.js at 0.57 and 13 ms, is dominated." src="./pareto-query-light.svg">
</picture>

**Backend one-shot ledger:** a cold search over fresh data pays index + query:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./pareto-total-dark.svg">
  <img alt="Mixed-corpus accuracy (MRR) vs. total cost of one cold search (index + one query, log scale) as a Pareto frontier. The frontier runs uFuzzy, uFuzzy (latinize), krino (smart), krino (acronym); fuzzysort's hidden prepare cache moves it off the frontier, and Fuse.js is dominated: krino (acronym) scores 0.62 at a 1.7 ms total against Fuse's 0.57 at ~14 ms." src="./pareto-total-light.svg">
</picture>

*Redraw both with `node docs/pareto.mjs` ([`pareto.mjs`](./pareto.mjs)); its `DATA` block is hand-pasted from the scorecard above, so re-paste the numbers after a scorecard refresh.*

## Size, speed & search type

These tables position each library rather than rank them; the method is uniform throughout.
**Gzip** = esbuild `--bundle --minify` + gzip, tree-shaken to each lib's primary API (see the Libraries table).
Each list size gets two columns: per-query mean ms, and **rel** = time relative to krino (100% = same, lower = faster).
The mixed table only lists configurations that fold diacritics, i.e. actually do that corpus's task (cross-checked per query by [`bench/hits.test.ts`](../bench/hits.test.ts)); a fast non-folding row would be fast at a different, easier job, so those are omitted and named below the table.
The ***all libraries*** row is the corpus-wide view: mean ± sd of per-query ms pooled across every configuration at that size.
Two seeded faker corpora, benched separately: **ascii** (en locale, effectively no diacritics) and **mixed** (mostly en with every 7th item from fr/pl generators, ~5% of items carry a diacritic, a realistic international dataset; items are ~97% unique, faker repeats a few names).
**(all opts)** rows switch on every opt-in the library has (diacritic folding, multi-word, highlight/ranges output) except typo modes, which stay off everywhere (krino can't reciprocate); base rows are stock defaults.
Benches consume every result into a sink (no dead-code elimination), and [`bench/hits.test.ts`](../bench/hits.test.ts) records per-library match counts for every query. Timing is only comparable because the matching is verified.
Full precision (including per-cell sd) + method are in [`bench/comparison.json`](../bench/comparison.json); regenerate with `pnpm bench && node bench/report.mjs`.
**Numbers vary per machine**; a sd rivalling its mean flags a noisy cell, not a stable result.
Grouped by type; within a type, sorted by size.

### Libraries

krino first, then the rest by ascending bundle size.

| Library          | Gzip    | Deps | Type                 |
|------------------|---------|------|----------------------|
| **krino**        | ~2.2 kB | 0    | subsequence (tiered) |
| fuzzy            | ~0.8 kB | 0    | substring            |
| @nozbe/microfuzz | ~1.7 kB | 0    | subsequence          |
| match-sorter     | ~3.4 kB | 2    | subsequence (tiered) |
| fuzzysort        | ~3.7 kB | 0    | subsequence          |
| uFuzzy           | ~4.1 kB | 0    | subsequence          |
| Fuse.js          | ~9.3 kB | 0    | typo-tolerant        |
| fast-fuzzy       | ~11 kB  | 1    | typo-tolerant        |

An "(all opts)" row in the corpus tables shares its base library's size, deps, and type.
krino's opt-in row is labelled **(acronym)** instead: `acronym: true` is its only opt-in beyond the `strategy` field, so the honest name is the specific one.

### ascii corpus

| Library                     | 10k            | 10k rel  | 100k             | 100k rel | Mean        |
|-----------------------------|----------------|----------|------------------|----------|-------------|
| **krino**                   | 0.32 ms        | **100%** | 3.74 ms          | **100%** | 100% ± 0    |
| krino (acronym)             | 0.39 ms        | 120%     | 5.45 ms          | 146%     | 133% ± 13   |
| @nozbe/microfuzz            | 1.47 ms        | 452%     | 20.51 ms         | 548%     | 500% ± 48   |
| @nozbe/microfuzz (all opts) | 1.46 ms        | 450%     | 15.43 ms         | 412%     | 431% ± 19   |
| fast-fuzzy                  | 10.44 ms       | 3212%    | 76.60 ms         | 2046%    | 2629% ± 583 |
| fast-fuzzy (all opts)       | 6.36 ms        | 1957%    | 78.43 ms         | 2095%    | 2026% ± 69  |
| fuse.js                     | 12.74 ms       | 3923%    | 131.42 ms        | 3511%    | 3717% ± 206 |
| fuse.js (all opts)          | 16.31 ms       | 5021%    | 167.62 ms        | 4478%    | 4749% ± 271 |
| fuzzy                       | 2.63 ms        | 809%     | 28.00 ms         | 748%     | 778% ± 30   |
| fuzzy (all opts)            | 2.68 ms        | 826%     | 29.87 ms         | 798%     | 812% ± 14   |
| fuzzysort                   | 0.38 ms        | 117%     | 6.70 ms          | 179%     | 148% ± 31   |
| match-sorter                | 3.43 ms        | 1057%    | 34.35 ms         | 917%     | 987% ± 70   |
| uFuzzy                      | 0.23 ms        | 70%      | 2.37 ms          | 63%      | 67% ± 3     |
| uFuzzy (all opts)           | 0.23 ms        | 69%      | 2.38 ms          | 64%      | 66% ± 3     |
| *all libraries*             | 4.22 ± 5.07 ms | —        | 43.06 ± 50.03 ms | —        | —           |

### mixed corpus

| Library                     | 10k            | 10k rel  | 100k             | 100k rel | Mean         |
|-----------------------------|----------------|----------|------------------|----------|--------------|
| **krino**                   | 0.13 ms        | **100%** | 1.49 ms          | **100%** | 100% ± 0     |
| krino (acronym)             | 0.17 ms        | 128%     | 2.02 ms          | 136%     | 132% ± 4     |
| @nozbe/microfuzz            | 1.38 ms        | 1060%    | 14.84 ms         | 997%     | 1029% ± 32   |
| @nozbe/microfuzz (all opts) | 1.37 ms        | 1046%    | 18.80 ms         | 1263%    | 1154% ± 108  |
| match-sorter                | 3.43 ms        | 2629%    | 35.87 ms         | 2410%    | 2519% ± 110  |
| fuzzysort                   | 0.30 ms        | 227%     | 4.48 ms          | 301%     | 264% ± 37    |
| uFuzzy (all opts)           | 0.23 ms        | 179%     | 2.31 ms          | 155%     | 167% ± 12    |
| fuse.js (all opts)          | 17.32 ms       | 13267%   | 173.15 ms        | 11633%   | 12450% ± 817 |
| *all libraries*             | 3.04 ± 5.50 ms | —        | 31.62 ± 54.63 ms | —        | —            |

Configurations that can't fold diacritics are omitted rather than flagged. A non-folding row on this corpus is timing a different, easier task (it silently misses accented matches), and we already *know* it fails: on the accent-probe query `kepa` (from "Kępa…") at 10k, base uFuzzy finds **0** matches where its folding (all opts) config finds 4 and krino 8 ([`bench/hits.test.ts`](../bench/hits.test.ts)).
Omitted: uFuzzy and fuse.js base configs (their (all opts) rows fold and stay), and fast-fuzzy and fuzzy entirely; they have no folding option at all.

## Reading the speed numbers

The tables start at 10k: below that every library answers in well under a millisecond (zero decision value), and sub-ms cells sit at timer granularity, so a 1k column would mostly measure jitter.
A staged reject path skips the tier ladder for non-candidates: a per-item union of char-class bitmasks in one `Int32Array` (a 4-byte read per item), then a native regex gate (subsequence for single-word queries, char-presence for multi-word), cutting 90–100% of items before any ladder work on these corpora.
A prefix-narrowing cache keeps the previous query's mask-gate survivors: when a query extends the last one (typing), only survivors are rescanned, and per-keystroke cost decays toward sub-millisecond as the phrase grows (typing 15 keystrokes over 100k items: ~179 ms before the cache, ~28 ms after; the session probe below shows the decay per keystroke).
krino beats its parent `@nozbe/microfuzz` at every size on both corpora (~4–5× on ascii, ~10× on mixed).
The (all opts) rows stay cheap in absolute terms across the board.
On the ascii corpus uFuzzy keeps a ~1.5× lead at scale: a single native-regex filter that ranks only survivors, where krino runs a full tier ladder and builds a `tier` + per-character `ranges` per match; that residual gap is the price of richer output, not overhead we can gate away.
On the mixed corpus the standings flip: krino leads every configuration outright, including uFuzzy with folding enabled (~167% of krino).
Cross-*type* speed isn't apples-to-apples: **typo-tolerant** libs (Fuse.js, fast-fuzzy) do far more work per query, and non-folding configurations are omitted from the mixed table entirely (they would be timing a different task).
**fast-fuzzy is corpus-sensitive**: its trie shines on shared-prefix data but this natural-language corpus prunes less, dropping it among the slowest (on a combinatorial word-grid it was ~4× *faster* than krino; corpus shape moves these numbers a lot).
For ascii-only 100k+ corpora, uFuzzy is still the raw-speed pick; on accented data at any size, the numbers favour krino.

## A frontend session: typing `grady` at 100k

Typing is a *sequence*: each query extends the last.
krino's prefix-narrowing cache rescans only the previous query's mask-gate survivors, so successive keystrokes get cheaper; every other library pays a full scan per keystroke.
The probe types the doc's surname query `grady` from the 3-character UI gate onward (real UIs gate search behind 2–3 characters, because a 1–2 char query matches a huge fraction of the corpus and every rich-result library pays to materialize it).
Each step is timed at its correct cache state (the untimed reset replays the previous prefix before every sample), on the 100k mixed corpus.

| Library            |  `gra` | `grad` | `grady` | session |
|--------------------|-------:|-------:|--------:|--------:|
| krino (smart)      |   5.87 |   2.57 |    0.68 |    9.12 |
| @nozbe/microfuzz   |  29.34 |  30.15 |   25.34 |   84.83 |
| fuzzysort          |  10.79 |   5.90 |    2.66 |   19.35 |
| uFuzzy (latinize)  |   2.58 |   2.48 |    2.47 |    7.54 |
| fuse.js (all opts) | 140.69 | 128.37 |  168.68 |  437.74 |

Three things this table says plainly.
First, krino's per-keystroke cost falls **8.6×** across the word (5.87 → 0.68) as the survivor cache narrows. The crossover is visible in the table: by the completed word, krino's keystroke is ~3.6× cheaper than uFuzzy's flat line, and it keeps falling (the 15-keystroke measurement lands a full phrase at ~28 ms with sub-millisecond keystrokes by mid-word).
Second, uFuzzy's flat ~2.5 ms still takes this short session's total (7.5 vs 9.1): its bare-index-array output owns the first keystrokes, at 0.26 MRR to krino's 0.57; longer phrases flip the total.
Third, microfuzz stays flat at ~28 ms: same subsequence approach, no cache; the decay *is* the cache.
All rows assume a warm process: one-time costs — krino's build, fuzzysort's lazy target prep — are paid at load, not on keystroke one; the Scorecard's index column carries them.
Regenerate with `pnpm --filter=krino-bench exec vitest run session --disable-console-intercept` ([`bench/session.test.ts`](../bench/session.test.ts)).

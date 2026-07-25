# Benchmarks: match quality and speed

Full data behind the README's summary: what each library calls a match, where it ranks the right answer, and what a query costs.
Every measured table below is generated, and `pnpm bench` regenerates all of them: it measures, writes [`bench/results.json`](../bench/results.json), rewrites each table in place, and redraws the Pareto charts.
No measured cell in this document is typed by hand.

- `pnpm bench --docs` re-emits the tables from the committed `results.json` without measuring anything.
- `pnpm bench --check` exits nonzero if any table here disagrees with `results.json`.
- `pnpm bench --speed` and `pnpm bench --quality` run one half of the measurement; `--runs=N` sets the scorecard's process count (default 5).
- `pnpm bench --scope=mixed-10k` scopes a dev run (tokens: a corpus, a size, or `corpus-size`, comma-separable). A scoped run measures a partial matrix, so it prints and stops: neither `results.json` nor this document is touched.

The pre-filter funnel ([`bench/funnel.test.ts`](../bench/funnel.test.ts)) is a diagnostic rather than a published table; run it with `pnpm --filter=krino-bench test`.
Improvements to the benchmarks are welcome.

## Libraries

The eight libraries compared throughout, and the configurations every table below is named after.
Feature coverage first; each cell is verified against the library's current source:

| Library                                                     | Per-field | Ranges | Diacritics | ESM | Multi-word | Typos | Tiers |
|-------------------------------------------------------------|:---------:|:------:|:----------:|:---:|:----------:|:-----:|:----:|
| **Krino**                                                   |    🟢     |   🟢   |     🟢     | 🟢  |     🟢     |  🟢   |  🟢  |
| [@nozbe/microfuzz](https://github.com/Nozbe/microfuzz)      |    🟢     |   🟢   |     🟢     | 🔴  |     🟢     |  🔴   |  🔴  |
| [fast-fuzzy](https://github.com/EthanRutherford/fast-fuzzy) |    🟢     |   🟡   |     🔴     | 🟢  |     🔴     |  🟢   |  🔴  |
| [Fuse.js](https://www.fusejs.io/)                           |    🟢     |   🟡   |     🟡     | 🟢  |     🟡     |  🟢   |  🔴  |
| [fuzzy](https://github.com/mattyork/fuzzy)                  |    🔴     |   🟡   |     🔴     | 🔴  |     🔴     |  🔴   |  🔴  |
| [fuzzysort](https://github.com/farzher/fuzzysort)           |    🟢     |   🟢   |     🟢     | 🔴  |     🟢     |  🔴   |  🔴  |
| [match-sorter](https://github.com/kentcdodds/match-sorter)  |    🟢     |   🔴   |     🟢     | 🟡  |     🔴     |  🔴   |  🟢  |
| [uFuzzy](https://github.com/leeoniya/uFuzzy)                |    🔴     |   🟢   |     🟡     | 🟡  |     🟡     |  🟡   |  🔴  |

🟢 built-in / on by default

🟡 opt-in or partial

🔴 not supported

Size and type, by bundle size ascending.

<!-- bench:libraries -->
| Library          | Gzip        | Deps  | Type                     |
|------------------|-------------|-------|--------------------------|
| fuzzy            | ~0.8 kB     | 0     | substring                |
| @nozbe/microfuzz | ~1.7 kB     | 0     | subsequence              |
| **Krino**        | **~3.1 kB** | **0** | **subsequence (tiered)** |
| match-sorter     | ~3.4 kB     | 2     | subsequence (tiered)     |
| fuzzysort        | ~3.7 kB     | 0     | subsequence              |
| uFuzzy           | ~4.1 kB     | 0     | subsequence              |
| Fuse.js          | ~9.3 kB     | 0     | typo-tolerant            |
| fast-fuzzy       | ~11 kB      | 1     | typo-tolerant            |
<!-- bench:end -->

An "(all opts)" row in the corpus tables shares its base library's size, deps, and type.
Krino's opt-in row is labelled **(acronym)** instead: `acronym: true` is its only matching opt-in, so the honest name is the specific one.
The specific opt-ins the "(all opts)" rows switch on, and where output shapes differ:

- `Krino`: Typos 🟢 is the always-on one-edit rescue, the `transposed`, `inserted`, `deleted` and `substituted` tiers, i.e. Damerau-Levenshtein distance 1, not general edit distance
- `uFuzzy`: folds diacritics via `latinize()`, matches multi-word via `outOfOrder`, and runs its one-typo `SingleError` mode with all four edits, the closest config to Krino's one-edit tiers
- `Fuse.js`: returns `ranges` via `includeMatches`, folds diacritics via `ignoreDiacritics`, matches multi-word via token search
- `fast-fuzzy`: its `ranges` are one span (`index` + `length`), not per-character, and its default normalization doesn't strip accents
- `fuzzy`: its "ranges" are a pre-wrapped string, not numeric indices

## How to read these numbers

The methodology lives here, once; the result sections point back to it instead of re-explaining.

### Three preparation strategies

Every query number in this document times a _prebuilt_ searcher, so the first question is where each library pays for its preparation.

- **Eager**: the constructor does real work and queries ride the result.
  Krino and fast-fuzzy build here.
  Fuse.js nominally sits here too, but its trivial index defers the real work to query time.
- **Lazy**: preparation hides inside the first search.
  microfuzz defers part of its preparation to the first search (its own docs: "the first search takes ~7 ms, subsequent under 1.5 ms"); its scorecard index cell prices that as time-to-ready (build + first search − one steady search), so the cell isolates preparation.
  fuzzysort quietly does the same: it prepares every string target on the first `go()` and caches them process-wide, ~87× the cost of a steady query at 10k; its index cell times that work as an explicit prepare-all pass.
- **None**: no state kept; the preparation runs inside every single query.
  uFuzzy, match-sorter, and fuzzy live here, and their first-call overhead is plain JIT warmup, which the harness's warm pass owes every library equally.
  One exception: uFuzzy (all opts)'s index cell is latinizing the haystack, real preparation that normally hides as "no index". The configuration that competes on the total column has to carry it.

Where preparation gets paid differs per library, which is why per-query numbers alone can't rank these libraries.
Which cost matters depends on workload: a frontend builds the index once at load and amortizes it across every keystroke, so **query** is its number; a backend one-shot search over fresh data pays index + one query, so **total** is.
Every cost table below reports **index**, **query**, and **total** separately so both readings stay available.

### Timing method

**Query cells are medians, not means.**
Timing noise is one-sided (GC, scheduler, and thermal interruptions only ever _add_ time), so a mean absorbs the spikes while a median rejects them.
Within a run each cell is the median of ~100 ms of individually-timed, cache-busted calls (see `timeQuery` in [`bench/hits.test.ts`](../bench/hits.test.ts)); the published scorecard value is the median across 5 fresh processes, which also cancels process-level drift (JIT tier-up, thermals, background load).
The cache-busting is a fairness requirement: an identical repeated query would time Krino's survivor-rescan path, the prefix-narrowing cache described under "Reading the speed numbers", while every other library pays a cold scan.

**Build cells are vitest bench means.**
Building an index is allocation-heavy (per-item strings, objects, and arrays), and the harness runs builds back-to-back with no idle time, so the garbage collector fires _during_ the timed iterations and its pauses land in the mean.
The distortion is visible across runs, not just within one: Krino's 100k build usually ranges from ~18 to ~51 ms on the same machine depending on load, while its standalone floor (best-of-N, GC quiet) is ~13–20 ms; this document's run measured 47 ms.
Relative rankings are our metric. Every library runs under the same harness, and the allocation-heavy builds are penalized together. Read absolute build cells as harness-conditioned ceilings, not steady-state costs.
Two mitigations bound the damage: every bench task starts with a forced collection (`--expose-gc` plus a setup hook), so one configuration's garbage can't land in its neighbour's window; and the pipeline refuses to write a run that violates a physical invariant (base Krino measuring slower than its strictly-more-code acronym configuration), which is how a contaminated run announces itself.

Two smaller notes.
The two Krino rows share one pooled index measurement (their builds are byte-identical; the acronym flag is query-time only): unpooled, sub-resolution noise of ±0.05 ms was enough to reverse their expected total-cost order.
And numbers are expected to vary per machine: swapping between my Mac ARM host and an AMD x64 showed subtly different relative results.

### The corpus and the fifteen probes

Two seeded [Faker](https://github.com/faker-js/faker) corpora, benched separately: **ascii** (en locale, effectively no diacritics) and **mixed** (mostly en with every 7th item from fr/pl generators, ~5% of items carry a diacritic, a realistic international dataset; items are ~97% unique at 10k, faker repeats a few names).
Both are frozen JSON snapshots (`bench/corpus-*.json`), so runs pay no generation cost and the data can't drift when faker changes between versions; regenerating them is a deliberate act ([`bench/corpus-gen.test.ts`](../bench/corpus-gen.test.ts)) that rewrites history for every rank table here.

Each query runs against the same 10,000 items in every library, and each library is scored on three things:

- **Where it ranks the queried item.**
  In most cases, a deep rank is effectively a miss, particularly in a UI, so a rank outside the top 10 counts as a miss.
  Scoring uses the mean reciprocal rank (average of `1/rank`), **MRR** from here on, a bounded score ranging from 0 to 1.
  A rank 1 match gets a score of 1, rank 2 gets 0.5, rank 5 gets 0.2 and rank 10 gets 0.1; a rank outside the top 10, like a miss, gets 0.
- **How many items it returns.**
  This is reported as a _diagnostic_, not a score. If 50% of the corpus is returned as a potential match, it's easy to guarantee that the true match exists.
  However this is not a meaningful quality axis: any ranked list can be sliced to the top N, many of these libraries even provide a limit or threshold option. Junk results cost nothing if they're never considered.
- **The duration taken to run the query.**
  Times spread three orders of magnitude on the same query (0.02 ms to ~40 ms at 10k), and search-as-you-type multiplies the spread: one query per keystroke, where 0.02 ms is invisible and 40 ms blows the frame budget.

Three rules picked the query set; none of them is "krino looks good here".

- **Every query is derived from the corpus.**
  Each one is generated from the frozen snapshot by a fixed rule: the first word of the item at sample position 4, the first _near-unique_ ≥7-char word from position 1300 on (≤ 2 corpus items may contain it, so a typo probe's rank measures ranking rather than position inside a tie block of identical scores), the initials of the first 3-word item, and so on ([`bench/corpus.ts`](../bench/corpus.ts)).
  Change the corpus snapshot and every query changes with it.
  Deriving from a real item is also the only reason _rank_ is measurable at all: each query has a known right answer to look for.
- **One probe per matching behaviour, including the ones krino loses.**
  The set walks the capability matrix; the table below names each probe and what it isolates.
- **Graded degradation instead of a pass/fail cliff.**
  The three scatter probes mutilate _one_ source word in steps (drop one middle char, drop every third, keep every other) because a single scattered query only says who passes it; the gradient locates each engine's _effective fuzzy limit_, which is the actual design difference between the chain matchers, the typo engines, and uFuzzy's no-gaps default.
  The heavy step is deliberately past any sane threshold: an engine that still "matches" there is reporting noise tolerance, not typo tolerance.
  Three further probes from the same source word degrade along a different axis: a **transposition** (two adjacent chars swapped), an **insertion** (a doubled keystroke), and a **substitution** (one wrong character, chosen to be absent from the source so it also costs a character class). All three keep the query close to the source but break the subsequence property, so no subsequence chain can represent them: they separate the engines that model edits from the engines that model subsequences.
  The scatter-light probe is the fourth single-character edit, a **deletion**, which does stay a subsequence and so is reachable without any rescue.

The resulting probes:

| #   | probe                         | query                     | isolates                                              |
|-----|-------------------------------|---------------------------|-------------------------------------------------------|
| 1   | long single word              | `ergonomic`               | baseline agreement; rank on a common word             |
| 2   | short single word             | `grady`                   | low-signal input, fewer chars for gates and chunking  |
| 3   | two-word phrase               | `handcrafted wooden`      | tokenization (in corpus order: any engine can pass)   |
| 4   | two words, reversed           | `wooden handcrafted`      | true order-independence, substring engines get 0      |
| 5   | prefix / partial word         | `auxen`                   | precision at a near-unique singleton                  |
| 6   | mid-word infix                | `gonom`                   | contains-anywhere vs start-anchored ranking           |
| 7–9 | typo gradient (light → heavy) | `hugutte` `huuete` `hget` | each engine's effective fuzzy limit                   |
| 10  | transposition typo            | `hugeutte`                | adjacent-swap handling, rescue tier vs edit distance  |
| 11  | insertion typo                | `hugueette`               | a doubled keystroke, one character too many           |
| 12  | substitution typo             | `huguxtte`                | one wrong character, absent from the source entirely  |
| 13  | acronym                       | `rsaw`                    | deliberate acronym support vs accidental subsequences |
| 14  | accent-stripped               | `kepa`                    | diacritic folding                                     |
| 15  | garbage                       | `qxzwkv`                  | the reject path, verifying no impossible matches      |

Fifteen queries aren't a workload: they can't estimate throughput or tail latency (the speed tables and the session probe below do that); they are chosen to make every library's matching _policy_ visible in one screen of tables, with each library given at least one probe where its specialty should win (token engines take the reversed phrase, folding engines the accent probe, edit-distance engines the three single-edit typo probes).
MRR over fourteen scored queries is correspondingly coarse: read differences of ±0.02 as ties.

## Build cost

<!-- bench:build -->
| build |    Krino | @nozbe/microfuzz | fast-fuzzy | Fuse.js | fuzzysort (lazy) |
|-------|---------:|-----------------:|-----------:|--------:|-----------------:|
| 10k   |  2.76 ms |         10.47 ms |   39.63 ms | 1.06 ms |          9.81 ms |
| 100k  | 46.99 ms |         89.75 ms |  655.93 ms | 8.69 ms |         90.99 ms |
<!-- bench:end -->

Measured on the mixed corpus; build cost barely differs between corpora.
(These cells are GC-inflated means; see "Timing method" for how much.)
Fuse.js's near-free build is the flip side of its slow queries: its "index" is trivial and the work is deferred to query time (1.06 ms at 10k and 8.69 at 100k, the cheapest build in the set at both sizes).
fast-fuzzy's trie is the opposite trade: the heaviest build in the set buys its subtree pruning.
fuzzysort's column is its lazy prepare-all pass: it has no constructor, and stock usage pays exactly that cost hidden inside the first `go()`.
microfuzz's column is eager-only; its lazy first-search slice is priced in the scorecard's index column instead (see "Three preparation strategies").
Krino prepares eagerly, so a 100k list swap costs ~47 ms once (this run's cell); keystrokes then ride the prefix cache (see the session table at the bottom).

## Match quality, probe by probe

Each library has its own definition of a match, so raw outputs aren't directly comparable.
To surface the differences, the fifteen probes run against every library; queries are from the mixed corpus at 10k.
One small table per query:

- **rank** = where the queried item placed (1 = top hit; ✗ = matched other things but lost the source; — = returned nothing)
- **matches** = how many of the 10,000 items the library returned
- **query ms** = time-boxed median of the raw search call against the _prebuilt_ searcher
- **total ms** = query + the configuration's one-time index cost, the honest cold one-shot number

("Total" approximates the _first_ query from cold, yet its query addend is a steady-state call, not a literal first call. That is deliberate: every one-time cost sits in the index column, including the lazy slices (see "Three preparation strategies"), so timing a real first call would double-count the preparation.)
The two time columns are equal for libraries that keep no index (their preparation runs inside every query), which is exactly why a single time column would be dishonest: it would compare Krino's warm query against uFuzzy's entire workload.
Magnitude only; the rigorous timings are the speed tables below.

Two scorecard libraries are left out of the per-query tables to keep them readable.
fuzzy behaves like a less capable microfuzz: identical ranks on the plain-word, two-word, prefix, and light-typo probes; it drifts on the deep-typo and acronym probes, returns nothing on the reversed-phrase probe (order-sensitive), and misses the accent probe outright (no folding).
match-sorter never places best on any query: some shown library always matches or beats it.
Both keep full per-query cells in [`bench/results.json`](../bench/results.json).
The garbage query `qxzwkv` gets a table of its own instead: it returns 0 everywhere, so there is no rank to report, but what it costs to return nothing is the whole point of the probe.

### long word: `ergonomic`

<!-- bench:probe-long-word -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |      76 |     0.19 |     1.50 |
| Krino (acronym)  |    1 |      76 |     0.19 |     1.50 |
| @nozbe/microfuzz |    1 |      76 |     1.20 |     8.16 |
| fast-fuzzy       |   13 |      82 |     7.18 |    36.07 |
| Fuse.js          |    1 |      81 |    16.63 |    17.22 |
| fuzzysort        |   20 |      76 |     0.14 |     7.12 |
| uFuzzy           |   29 |      76 |     0.22 |     0.22 |
<!-- bench:end -->

The subsequence libraries agree on the set (76); the typo engines add a handful (81–82). The speed comparison is meaningful because they are returning near enough the same thing.
Rank is the differentiator: Krino/microfuzz put the source first; fuzzysort and uFuzzy sink it to 20th–29th.

### short word: `grady`

<!-- bench:probe-short-word -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |      24 |     0.23 |     1.54 |
| Krino (acronym)  |    1 |      24 |     0.24 |     1.55 |
| @nozbe/microfuzz |    1 |      36 |     0.99 |     7.94 |
| fast-fuzzy       |    2 |     382 |     6.36 |    35.12 |
| Fuse.js          |    1 |     375 |    11.24 |    11.87 |
| fuzzysort        |    2 |      36 |     0.13 |     7.12 |
| uFuzzy           |    2 |      19 |     0.20 |     0.20 |
<!-- bench:end -->

A second plain-word probe from elsewhere in the corpus. Krino ranks the source first, as on the long word, but on a 5-character query the one-edit rescue widens its set to 24: uFuzzy's 19 is the tightest here, at rank 2.

### two words: `handcrafted wooden`

<!-- bench:probe-two-words -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |       5 |     0.03 |     1.35 |
| Krino (acronym)  |    1 |       5 |     0.03 |     1.35 |
| @nozbe/microfuzz |    1 |       5 |     1.06 |     8.02 |
| fast-fuzzy       |    1 |      95 |     8.31 |    37.06 |
| Fuse.js          |    1 |      95 |    40.31 |    40.95 |
| fuzzysort        |    1 |       5 |     0.12 |     7.10 |
| uFuzzy           |    2 |       5 |     0.13 |     0.13 |
<!-- bench:end -->

Five items contain both words; every subsequence library returns exactly those five.
The typo engines return 19× that, and Fuse.js takes ~40 ms to do it (its extended-search tokenization is the most expensive path here).
One caveat on the agreement: the phrase is in corpus order, so it is a contiguous substring of the source: engines with no tokenization at all pass this probe for free.
The next probe removes that shortcut.

### two words, reversed: `wooden handcrafted`

<!-- bench:probe-two-words-reversed -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |       5 |     0.03 |     1.34 |
| Krino (acronym)  |    1 |       5 |     0.03 |     1.34 |
| @nozbe/microfuzz |    1 |       5 |     1.00 |     7.96 |
| fast-fuzzy       |    5 |      76 |     8.33 |    37.31 |
| Fuse.js          |    1 |      76 |    40.24 |    40.84 |
| fuzzysort        |    1 |       5 |     0.11 |     7.10 |
| uFuzzy           |    — |       0 |     0.10 |     0.10 |
<!-- bench:end -->

These are the same two words in the opposite order, so this is the probe that actually isolates tokenized matching.
The tokenizing engines keep exactly the five items at rank 1; uFuzzy's default (in-order terms), match-sorter, and fuzzy all drop to _0 matches_ on a query a user would type without thinking.
(fuzzysort passes not by tokenizing but by chaining subsequences; the same permissiveness that costs it elsewhere happens to cover word order.)

### infix: `gonom`

<!-- bench:probe-infix -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    5 |      76 |     0.35 |     1.67 |
| Krino (acronym)  |    5 |      76 |     0.38 |     1.70 |
| @nozbe/microfuzz |    5 |      88 |     0.99 |     7.95 |
| fast-fuzzy       |   14 |     197 |     6.31 |    35.02 |
| Fuse.js          |    5 |     174 |    11.32 |    11.92 |
| fuzzysort        |   13 |      88 |     0.17 |     7.16 |
| uFuzzy           |   58 |      76 |     0.24 |     0.24 |
<!-- bench:end -->

An interior slice of "ergonomic", never a prefix, so start-anchored ranking gets no help.
Every library matches something; where the source _ranks_ is the spread: the contains-tier engines put it 5th, the prefix-biased rankers sink it (fuzzysort 13th, uFuzzy 58th; same 76-item set as Krino, very different ordering).

### prefix: `auxen`

<!-- bench:probe-prefix -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |      16 |     0.22 |     1.54 |
| Krino (acronym)  |    1 |      16 |     0.22 |     1.54 |
| @nozbe/microfuzz |    1 |       1 |     1.14 |     8.09 |
| fast-fuzzy       |    1 |     452 |     6.48 |    35.06 |
| Fuse.js          |    1 |     444 |    11.45 |    12.04 |
| fuzzysort        |    1 |       1 |     0.11 |     7.09 |
| uFuzzy           |    1 |       1 |     0.23 |     0.23 |
<!-- bench:end -->

One item matches this prefix literally, and the pure subsequence engines return exactly it.
Krino returns 16 because its one-edit rescue also admits the corrections of `auxen`, all scored below the literal `prefix` hit that takes rank 1. The always-on typo tolerance costs a wider set on a query that did not need it.
The typo engines are the other end of that trade, ~450 candidates for the same one true hit.

### the fuzzy limit: `hugutte` / `huuete` / `hget`

Three probes degrade one source word ("Huguette", near-unique in the corpus) in steps: **light** drops one middle char (`hugutte`, a sloppy keystroke), **medium** drops every third char (`huuete`), **heavy** keeps only every other char (`hget`, 1–2 char fragments).
Where a library stops surfacing the source is its effective fuzzy limit.

**light (`hugutte`):**

<!-- bench:probe-scatter-light -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |       1 |     0.17 |     1.49 |
| Krino (acronym)  |    1 |       1 |     0.18 |     1.49 |
| @nozbe/microfuzz |    1 |       5 |     0.99 |     7.95 |
| fast-fuzzy       |    1 |       1 |     6.01 |    34.82 |
| Fuse.js          |    1 |       1 |    11.89 |    12.53 |
| fuzzysort        |    1 |       5 |     0.13 |     7.11 |
| uFuzzy           |    — |       0 |     0.17 |     0.17 |
<!-- bench:end -->

**medium (`huuete`):**

<!-- bench:probe-scatter-medium -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |       1 |     0.33 |     1.65 |
| Krino (acronym)  |    1 |       1 |     0.33 |     1.65 |
| @nozbe/microfuzz |    1 |       9 |     0.98 |     7.93 |
| fast-fuzzy       |    1 |      26 |     5.78 |    34.51 |
| Fuse.js          |    3 |      26 |    11.18 |    11.79 |
| fuzzysort        |    1 |       9 |     0.19 |     7.16 |
| uFuzzy           |    — |       0 |     0.12 |     0.12 |
<!-- bench:end -->

**heavy (`hget`):**

<!-- bench:probe-scatter-heavy -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    — |       0 |     0.12 |     1.44 |
| Krino (acronym)  |    — |       0 |     0.15 |     1.47 |
| @nozbe/microfuzz |   21 |      67 |     1.00 |     7.95 |
| fast-fuzzy       |    ✗ |      24 |     5.28 |    34.10 |
| Fuse.js          |    ✗ |      24 |     7.17 |     7.81 |
| fuzzysort        |    1 |      67 |     0.16 |     7.15 |
| uFuzzy           |    — |       0 |     0.20 |     0.20 |
<!-- bench:end -->

The gradient locates each engine's limit.
Krino surfaces the source _first with exactly one row_ through light and medium, then refuses outright at the heavy grade: 1–2 char fragments fail its chunking rules, and returning nothing beats returning the 67 junk chains the chain engines assemble.
microfuzz keeps matching at every level (rank 21 in 67 rows on `hget`), the behaviour Krino inherited and deliberately changed to refusal; fuzzysort even ranks the source first there, by accepting the same 67-chain noise.
The typo engines hold rank 1 on light but shed precision as the signal thins: Fuse.js slips to 3rd on medium and both lose the source at heavy (✗, 24 junk rows).
uFuzzy's default tolerates no intra-word gaps at all, 0 at every level.

### the transposition: `hugeutte`

<!-- bench:probe-transposition -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |       1 |     0.17 |     1.49 |
| Krino (acronym)  |    1 |       1 |     0.17 |     1.49 |
| @nozbe/microfuzz |    ✗ |       2 |     0.98 |     7.93 |
| fast-fuzzy       |    1 |       6 |     6.43 |    35.24 |
| Fuse.js          |    1 |       6 |    15.62 |    16.22 |
| fuzzysort        |    ✗ |       2 |     0.13 |     7.11 |
| uFuzzy           |    — |       0 |     0.16 |     0.16 |
<!-- bench:end -->

The fourth typo probe degrades the same source word along a different axis: two adjacent characters swapped (`huguette` → `hugeutte`), same character count, wrong order.
Deletions leave a query that is still a subsequence of its source; a transposition does not, so no subsequence _chain_ can represent it: microfuzz and fuzzysort lose the source (✗; their two "matches" are other items the letters happen to chain through) and uFuzzy returns 0.
Krino does not rely on subsequence here: after every tier in the ladder misses, a dedicated rescue retries each single-edit correction of the query and accepts only real-tier hits, scored as the corrected tier + 2.1 (tiers `transposed`, `inserted`, `deleted`, `substituted`).
That surfaces the source _first, with exactly one row_. The edit-distance engines also rank it first but arrive with 6 candidates.
The penalty is sized so that even the best correction sorts below the weakest literal tier (`contains`): a correction is a guess at what the user meant, a substring match is something they actually typed, so the literal hit always wins. Sizing it lower sinks infix ranking, because another item's guess then displaces the item the query literally appears in.
Multi-error edits (two or more) remain the edit-distance engines' territory, and the scorecard prices that boundary.

### the insertion: `hugueette`

<!-- bench:probe-insertion -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |       1 |     0.17 |     1.49 |
| Krino (acronym)  |    1 |       1 |     0.17 |     1.49 |
| @nozbe/microfuzz |    — |       0 |     0.98 |     7.94 |
| fast-fuzzy       |    1 |       1 |     6.29 |    35.10 |
| Fuse.js          |    1 |       1 |    15.96 |    16.55 |
| fuzzysort        |    — |       0 |     0.13 |     7.11 |
| uFuzzy           |    — |       0 |     0.17 |     0.17 |
<!-- bench:end -->

A doubled keystroke (`huguette` → `hugueette`), one character too many.
A subsequence engine cannot represent an _extra_ character at all (there is no way to skip a query character), so microfuzz, fuzzysort and uFuzzy return _0_ matches rather than ranking the source poorly.
Krino, fast-fuzzy and Fuse.js all return exactly the source, at rank 1.
Krino gets there by dropping each character of the query in turn and rerunning the ladder on the corrections (tier `inserted`), which costs it a rescue pass on this query but nothing on the queries that match literally.

### the substitution: `huguxtte`

<!-- bench:probe-substitution -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    1 |       1 |     0.06 |     1.38 |
| Krino (acronym)  |    1 |       1 |     0.06 |     1.38 |
| @nozbe/microfuzz |    — |       0 |     0.97 |     7.93 |
| fast-fuzzy       |    1 |       1 |     6.51 |    35.14 |
| Fuse.js          |    1 |       1 |    15.81 |    16.41 |
| fuzzysort        |    — |       0 |     0.10 |     7.09 |
| uFuzzy           |    — |       0 |     0.17 |     0.17 |
<!-- bench:end -->

One wrong character, and deliberately one the source does not contain anywhere (`e` → `x`).
That second property is why this is the hardest of the four edits for Krino specifically: the char-class bitmask gate rejects an item missing any of the query's character classes, so a single character absent from the corpus item would otherwise eliminate it before any tier runs.
Reaching it at all required the gate to tolerate exactly one missing class, the single most expensive change in the library, because that gate is what rejects 90–100% of items on every other query (see "Reading the speed numbers").
The matcher itself is cheap: one half of the query must survive a single substitution, so the two halves' occurrences are the only windows worth testing.
Same outcome as the insertion probe. The three subsequence engines return 0, the typo-tolerant engines and Krino return exactly the source.

### acronym: `rsaw`

<!-- bench:probe-acronym -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    2 |       7 |     0.18 |     1.50 |
| Krino (acronym)  |    1 |       8 |     0.24 |     1.55 |
| @nozbe/microfuzz |    2 |     133 |     1.17 |     8.13 |
| fast-fuzzy       |    ✗ |      28 |     5.73 |    34.42 |
| Fuse.js          |    ✗ |      28 |     7.12 |     7.76 |
| fuzzysort        |    2 |     133 |     0.20 |     7.19 |
| uFuzzy           |    — |       0 |     0.19 |     0.19 |
<!-- bench:end -->

`rsaw` is the initials of "Rath, Streich and Witting".
Krino's opt-in acronym tier ranks the source _first_ with a tight set of 8, while Krino/microfuzz/fuzzysort land it second (the chain engines by matching 133 scattered subsequences, Krino via single-char word-boundary chunks; Krino's base row shows 7: the density floor, the minimum share of the span a fuzzy assembly has to cover, drops one junk chain the acronym tier keeps as a real initials hit).
The typo engines lose the source entirely (✗); uFuzzy's defaults find nothing.
Tier semantics: apostrophes are word-internal (`People's` contributes one initial, `p`), and stopwords are not skipped (`drc` won't match "Democratic Republic of the Congo" at all: the acronym is `drotc`, and the density floor rejects the sparse `d`/`r`/`c` fuzzy chain at 0.107, under the 0.18 minimum).

### accents: `kepa`

<!-- bench:probe-accent-stripped -->
| Library          | rank | matches | query ms | total ms |
|------------------|-----:|--------:|---------:|---------:|
| Krino            |    2 |       7 |     0.10 |     1.41 |
| Krino (acronym)  |    2 |       7 |     0.12 |     1.44 |
| @nozbe/microfuzz |    2 |      70 |     1.00 |     7.95 |
| fast-fuzzy       |   33 |      82 |     5.69 |    34.11 |
| Fuse.js          |    1 |      74 |     7.23 |     7.82 |
| fuzzysort        |    2 |      70 |     0.15 |     7.14 |
| uFuzzy           |    — |       0 |     0.20 |     0.20 |
<!-- bench:end -->

`kepa` targets items containing "Kępa".
uFuzzy's 0 is the silent diacritics miss; its opt-in `latinize` config finds 4.
fast-fuzzy's 82 come from edit distance rather than folding, and the source lands at rank 33.

### garbage: `qxzwkv`

<!-- bench:probe-miss -->
| Library          | matches | query ms | vs `ergonomic` |
|------------------|--------:|---------:|---------------:|
| Krino            |       0 |    0.025 |            13% |
| Krino (acronym)  |       0 |    0.025 |            13% |
| @nozbe/microfuzz |       0 |    0.881 |            74% |
| fast-fuzzy       |       0 |    5.366 |            75% |
| Fuse.js          |       0 |   11.068 |            67% |
| fuzzysort        |       0 |    0.104 |            75% |
| uFuzzy           |       0 |    0.103 |            47% |
<!-- bench:end -->

No rank column: every library correctly returns nothing, which is the only right answer.
What separates them is the price of that answer, shown against each library's own cost for the long-word probe (a query that does match), so the column reads as "what fraction of a real query does a hopeless one cost you".
Krino answers in _13%_ of a matching query because the character-class mask rejects on one integer AND, before any regex runs; every other engine pays 47–75%, because a miss is only knowable after the full scan.
This is the probe the gate architecture exists for.

It is also the probe to keep in mind when reading the aggregate speed tables, which average all fifteen queries: a cheap reject is a real advantage on real traffic, where users type garbage constantly, but it flatters Krino's mean by about 6% against roughly 1% for microfuzz. Excluding it moves Krino from 6.44× to 6.13× microfuzz's per-query mean, which changes no conclusion in this document.

## Scorecard

One line per configuration, computed by [`bench/hits.test.ts`](../bench/hits.test.ts) over the tables above; the published numbers are the median across 5 fresh benchmark processes (see "Timing method"), which `pnpm bench --runs=N` controls.
**MRR** = mean reciprocal rank of the queried item across the 14 scored queries, with the top-10 cutoff from "The corpus and the fifteen probes": misses and ranks outside the top 10 score 0.
**index ms** = the one-time cost of building the searcher (— for libraries that keep no index; how the lazy and hidden preparation is priced is in "Three preparation strategies").
**query ms** = per-query cost averaged across all 15 queries.
**total ms** = index + one query, the cold-start cost.
Which column matters depends on workload: frontend → **query**; backend one-shot → **total**.

**mixed corpus** (the query set above):

<!-- bench:scorecard-mixed -->
| Library            |  MRR | index ms | query ms | total ms |
|--------------------|-----:|---------:|---------:|---------:|
| Krino (acronym)    | 0.84 |     1.32 |     0.17 |     1.49 |
| Krino              | 0.80 |     1.32 |     0.16 |     1.48 |
| Fuse.js            | 0.75 |     0.60 |    15.62 |    16.22 |
| Fuse.js (all opts) | 0.75 |     0.56 |    17.63 |    18.19 |
| @nozbe/microfuzz   | 0.59 |     6.96 |     1.02 |     7.98 |
| fast-fuzzy         | 0.55 |    28.81 |     6.47 |    35.28 |
| fuzzysort          | 0.54 |     6.99 |     0.14 |     7.12 |
| fuzzy              | 0.45 |        — |     2.29 |     2.29 |
| uFuzzy (all opts)  | 0.42 |     0.60 |     0.25 |     0.85 |
| match-sorter       | 0.41 |        — |     2.82 |     2.82 |
| uFuzzy             | 0.14 |        — |     0.18 |     0.18 |
<!-- bench:end -->

**ascii corpus** (its own query set over its own corpus, down to its own accent probe, `cote` from "Côte d'Ivoire", which the en locale emits; MRRs therefore aren't comparable across corpora):

<!-- bench:scorecard-ascii -->
| Library            |  MRR | index ms | query ms | total ms |
|--------------------|-----:|---------:|---------:|---------:|
| Krino (acronym)    | 0.77 |     1.48 |     0.29 |     1.77 |
| Krino              | 0.73 |     1.48 |     0.26 |     1.74 |
| Fuse.js            | 0.61 |     0.98 |    16.09 |    17.07 |
| Fuse.js (all opts) | 0.61 |     0.82 |    18.82 |    19.64 |
| @nozbe/microfuzz   | 0.60 |     7.18 |     1.01 |     8.19 |
| fuzzy              | 0.43 |        — |     1.73 |     1.73 |
| fast-fuzzy         | 0.40 |    36.40 |     7.90 |    44.30 |
| uFuzzy (all opts)  | 0.38 |     0.55 |     0.24 |     0.80 |
| match-sorter       | 0.31 |        — |     2.65 |     2.65 |
| fuzzysort          | 0.29 |     7.03 |     0.16 |     7.19 |
| uFuzzy             | 0.11 |        — |     0.17 |     0.17 |
<!-- bench:end -->

Result-set size is _not_ a scorecard column: in a ranked UI any result list slices to the top N, so a large return costs a picker nothing (see "The corpus and the fifteen probes").
The per-query tables above keep the raw counts for the two places size does matter: filter-style UIs that show every match, and telling whether an MRR came from a selective matcher or from ranking a huge candidate set.
_Krino (acronym) tops both corpora outright_ (0.84 mixed / 0.77 ascii): only a deliberate acronym tier ranks initials first, while Fuse.js _loses the source_ on that query and lands at 0.75, arriving with ~90-row median lists (mean ~185) at ~16 ms where Krino's answer costs 0.17 ms.
On structured queries Krino returns a median of _7_ rows where Fuse ships ~90.
Base Krino leads its parent and Fuse.js outright on both corpora (mixed 0.80 vs 0.59 / 0.75; ascii 0.73 vs 0.60 / 0.61): the one-edit tiers take all three single-edit typo probes at rank 1 with a single row each, where the subsequence engines return nothing at all on the insertion and substitution probes.
Rank inside junk does not score, so refusal at the heavy scatter grade is cheap (microfuzz's rank-21-in-67-junk-rows on `hget` earns 0 either way; see "the fuzzy limit").
uFuzzy's typo configuration is the largest spread in the table (0.42 mixed / 0.38 ascii against 0.14 / 0.11 for its defaults), so most of what separates uFuzzy from the field on these probes comes down to configuration rather than capability.

The scorecard's cost columns are exactly what the Pareto charts draw, one per workload; both draw the mixed 10k scorecard.

**Frontend workload** (the index is built once at load, so keystrokes pay query only):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./pareto-query-dark.svg">
  <img alt="Mixed-corpus accuracy (MRR) vs. query ms with indexes prebuilt, log scale, as a Pareto frontier. The frontier is Krino (acronym) at 0.84 MRR and 0.17 ms, with base Krino close behind at 0.80; every other configuration, including Fuse.js at 0.75 and 16 ms, is dominated." src="./pareto-query-light.svg">
</picture>

Its frontier runs fuzzysort → Krino → Krino (acronym).
Krino owns the top of it: nothing matches 0.84 MRR, and base Krino sits just under at 0.80.
It does not own the whole curve. fuzzysort's 0.14 ms query is cheaper than Krino's 0.16 ms, so anyone willing to trade 0.26 MRR for 0.02 ms has a point on the frontier.
That is the one-edit tiers' bill: they roughly double Krino's query cost, which is what moved fuzzysort onto the curve.

**Backend one-shot workload** (a cold search over fresh data pays index + query): the chart lives in the README's Comparison section, deliberately the less flattering of the two there.
Its frontier runs uFuzzy → uFuzzy (all opts) → Krino → Krino (acronym): the no-index engines own the cheapest cold one-shots, fuzzysort's hidden prepare cache moves it off the frontier, and Fuse.js is dominated.
uFuzzy (all opts) is a genuine frontier point here, at a 0.85 ms total against Krino's 1.48: its typo mode costs it almost nothing per query (0.25 ms) and triples its MRR over its defaults, and the 0.60 ms of that total is latinizing the haystack, preparation it must be charged for, since it is the configuration competing on this axis.

_Both charts read the scorecard above out of [`bench/results.json`](../bench/results.json) ([`pareto.ts`](./pareto.ts)), so they cannot disagree with it; `pnpm bench` redraws them._

## Size, speed & search type

These tables position each library rather than rank them; the method is uniform throughout.
**Gzip** = esbuild `--bundle --minify` + gzip, tree-shaken to each lib's primary API (the size table is in [Libraries](#libraries)).
Absolute columns first, then relative: **index** = the one-time 100k build cost (— for libraries that keep no index: their preparation runs inside every query, and a variant row shares its base library's build), **query** = per-query mean ms against a _prebuilt_ searcher, **total** = index + one query (the cold one-shot cost, matching the scorecard's ledger); the two **rel** columns restate query and total relative to Krino (100% = same, lower = faster).
The aggregate row is a **geometric mean**: per-library times span three orders of magnitude, so an arithmetic mean would only describe the slowest library; the geomean is the standard aggregate for multiplicative spreads.
The geomean row's rel cells are the geomean of each rel column (identically: field geomean ÷ Krino, since a geomean of ratios is the ratio of geomeans); the **geomean vs Krino** row restates the field average as a multiple of Krino per metric, in the same Krino=100% direction as every other percentage in the table. Its main addition is the index column, which has no rel of its own.
Only the 100k size is published: sub-millisecond 10k cells sit at timer granularity and mostly publish noise; the 10k measurements remain in [`bench/results.json`](../bench/results.json).
The two corpora are described in "The corpus and the fifteen probes"; they're benched separately.
The mixed table only lists configurations that fold diacritics, i.e. actually do that corpus's task (cross-checked per query by [`bench/hits.test.ts`](../bench/hits.test.ts)); a fast non-folding row would be fast at a different, easier job, so those are omitted and named below the table.
The **_all libraries_** row is the corpus-wide view: the geometric mean of every shown configuration at that size.
**(all opts)** rows switch on every opt-in the library has: diacritic folding, multi-word, highlight/ranges output, and typo modes; base rows are stock defaults, and [Libraries](#libraries) itemizes which opt-in is which.
Typo modes are included because Krino's one-edit matching is always on and cannot be disabled, so holding another engine's typo mode off would time two engines doing different jobs.
Only uFuzzy is affected in practice. Fuse.js (Bitap) and fast-fuzzy (edit distance) are typo-tolerant in every configuration here.
Benches consume every result into a sink (no dead-code elimination), and [`bench/hits.test.ts`](../bench/hits.test.ts) records per-library match counts for every query, so the timings above are known to be timing comparable work.
Full precision (including per-cell sd) + method are in [`bench/results.json`](../bench/results.json).
Krino leads its own table; the rest are alphabetical, so each library's base and (all opts) rows sit together and nothing is ordered by how well it did.

### ascii corpus

<!-- bench:speed-ascii -->
| Library                     | 100k index | 100k query | 100k total | query rel | total rel |
|-----------------------------|-----------:|-----------:|-----------:|----------:|----------:|
| **Krino**                   |   46.99 ms |    3.57 ms |   50.55 ms |  **100%** |  **100%** |
| Krino (acronym)             |   46.99 ms |    4.17 ms |   51.16 ms |      117% |      101% |
| @nozbe/microfuzz            |   89.75 ms |   18.15 ms |  107.90 ms |      509% |      213% |
| @nozbe/microfuzz (all opts) |   89.75 ms |   14.21 ms |  103.96 ms |      398% |      206% |
| fast-fuzzy                  |  655.93 ms |   77.92 ms |  733.84 ms |     2184% |     1452% |
| fast-fuzzy (all opts)       |  655.93 ms |   77.45 ms |  733.37 ms |     2170% |     1451% |
| Fuse.js                     |    8.69 ms |  165.09 ms |  173.78 ms |     4627% |      344% |
| Fuse.js (all opts)          |    8.69 ms |  197.61 ms |  206.30 ms |     5538% |      408% |
| fuzzy                       |          — |   27.09 ms |   27.09 ms |      759% |       54% |
| fuzzy (all opts)            |          — |   27.92 ms |   27.92 ms |      782% |       55% |
| fuzzysort                   |   90.99 ms |    4.77 ms |   95.75 ms |      134% |      189% |
| match-sorter                |          — |   31.48 ms |   31.48 ms |      882% |       62% |
| uFuzzy                      |          — |    2.24 ms |    2.24 ms |       63% |        4% |
| uFuzzy (all opts)           |          — |    2.61 ms |    2.61 ms |       73% |        5% |
| _all libraries (geomean)_   |   72.09 ms |   18.38 ms |   59.79 ms |      515% |      118% |
| _geomean vs Krino_          |       153% |       515% |       118% |      515% |      118% |
<!-- bench:end -->

### mixed corpus

<!-- bench:speed-mixed -->
| Library                     | 100k index | 100k query | 100k total | query rel | total rel |
|-----------------------------|-----------:|-----------:|-----------:|----------:|----------:|
| **Krino**                   |   46.99 ms |    2.24 ms |   49.22 ms |  **100%** |  **100%** |
| Krino (acronym)             |   46.99 ms |    3.77 ms |   50.75 ms |      168% |      103% |
| @nozbe/microfuzz            |   89.75 ms |   14.04 ms |  103.79 ms |      627% |      211% |
| @nozbe/microfuzz (all opts) |   89.75 ms |   14.43 ms |  104.18 ms |      645% |      212% |
| Fuse.js (all opts)          |    8.69 ms |  183.49 ms |  192.18 ms |     8200% |      390% |
| fuzzysort                   |   90.99 ms |    4.02 ms |   95.01 ms |      180% |      193% |
| match-sorter                |          — |   34.25 ms |   34.25 ms |     1530% |       70% |
| uFuzzy (all opts)           |          — |    2.73 ms |    2.73 ms |      122% |        6% |
| _all libraries (geomean)_   |   49.13 ms |   10.21 ms |   51.05 ms |      456% |      104% |
| _geomean vs Krino_          |       105% |       456% |       104% |      456% |      104% |
<!-- bench:end -->

The acronym configuration runs strictly _more_ code per query (an extra tier, plus the one-edit rescues on candidates that reach it); its 168% cell is that price plus load swing.
Read sub-15% differences as statistical ties, the tie band from here on, and larger ones as real.
Folding uFuzzy is outside the tie band on this corpus, and Krino is now the one ahead: 2.24 ms to uFuzzy's 2.73 (122%).

Configurations that can't fold diacritics are omitted rather than flagged. A non-folding row on this corpus is timing a different, easier task (it silently misses accented matches), and we already _know_ it fails: on the accent-probe query `kepa` (from "Kępa…") at 10k, base uFuzzy finds _0_ matches where its folding (all opts) config finds 4 and Krino 8 ([`bench/hits.test.ts`](../bench/hits.test.ts)).
Omitted: uFuzzy and fuse.js base configs (their (all opts) rows fold and stay), and fast-fuzzy and fuzzy entirely; they have no folding option at all.

### Reading the speed numbers

The tables publish 100k only: below that every library answers in single-digit milliseconds or less, and sub-millisecond cells sit at timer granularity, so smaller sizes would mostly measure jitter (the scorecard's 10k query cells use a median-of-medians method built for that scale).
A staged reject path skips the tier ladder for non-candidates: a per-item union of char-class bitmasks in one `Int32Array` (a 4-byte read per item), then a native regex gate (subsequence for single-word queries, char-presence for multi-word), cutting 90–100% of items before any ladder work on these corpora.
A prefix-narrowing cache keeps the previous query's mask-gate survivors: when a query extends the last one (typing), only survivors are rescanned, so per-keystroke cost decays as the phrase grows (the session probe below measures the decay).
Krino beats its parent `@nozbe/microfuzz` on both corpora (~5.1× on ascii and ~6.3× on mixed, base configs).
The (all opts) rows stay close to their base configuration across the board.
_uFuzzy is the faster engine at 100k on ascii_: 2.24 ms to Krino's 3.57 (63%). On mixed with both folding the order reverses, Krino's 2.24 ms to uFuzzy's 2.73 (122%).
It runs a single native-regex filter and ranks only survivors, where Krino runs a full tier ladder, builds per-character `ranges`, and carries always-on one-edit typo matching that uFuzzy only matches when its `SingleError` mode is switched on.
That capability gap is the trade: uFuzzy's typo configuration costs it almost nothing here (2.61 ms on ascii) but ranks the queried item at 0.38 MRR against Krino's 0.77.
Cross-_type_ speed isn't apples-to-apples: **typo-tolerant** libs (Fuse.js, fast-fuzzy) do far more work per query, and non-folding configurations are omitted from the mixed table entirely (they would be timing a different task).
**fast-fuzzy is corpus-sensitive**: its trie rewards shared-prefix data but this natural-language corpus prunes less, dropping it among the slowest (on a combinatorial word-grid it was ~4× _faster_ than Krino; corpus shape moves these numbers a lot).
For 100k+ corpora where raw query throughput dominates and a bare index array is enough output, uFuzzy is the faster choice on ascii, where Krino's case rests on rank quality and richer output rather than speed.

## A frontend session: typing `grady` at 100k

Typing is a _sequence_: each query extends the last.
Krino's prefix-narrowing cache rescans only the previous query's mask-gate survivors, so successive keystrokes get cheaper; every other library pays a full scan per keystroke.
The probe types the doc's surname query `grady` from the 3-character UI gate onward (real UIs gate search behind 2–3 characters, because a 1–2 char query matches a huge fraction of the corpus and every rich-result library pays to materialize it).
Each step is timed at its correct cache state (the untimed reset replays the previous prefix before every sample), on the 100k mixed corpus.

<!-- bench:session -->
| Library            |  `gra` | `grad` | `grady` | session |
|--------------------|-------:|-------:|--------:|--------:|
| Krino              |   4.40 |   2.49 |    2.65 |    9.54 |
| @nozbe/microfuzz   |  33.22 |  26.46 |   25.95 |   85.63 |
| fuzzysort          |  10.32 |   4.69 |    2.56 |   17.58 |
| uFuzzy (all opts)  |   2.61 |   2.51 |    2.60 |    7.72 |
| Fuse.js (all opts) | 141.92 | 129.04 |  172.42 |  443.38 |
<!-- bench:end -->

Krino's per-keystroke cost falls _1.7×_ between the first keystroke and the rest (4.40 → 2.49) as the survivor cache narrows: the 3-character query is the widest candidate set the session ever sees, and it is the one that pays.
uFuzzy's flat ~2.6 ms takes this short session's total (7.72 vs 9.54), and by the completed word the two are inside the tie band (2.65 vs 2.60): its bare-index-array output owns the short prefixes, at 0.42 MRR to Krino's 0.80.
microfuzz stays flat at ~26–33 ms: same subsequence approach with no survivor cache, so nothing narrows between keystrokes.
Unlike the scorecard, this table is a single process rather than a median of five, so read its cells with the tie band in mind.
All rows assume a warm process: one-time costs (Krino's build, fuzzysort's lazy target prep) are paid at load, not on keystroke one; the Scorecard's index column carries them.
Measured by [`bench/session.test.ts`](../bench/session.test.ts).

## Matching inside long text

Everything above matches short labels in a list; the other workload is one large string: `fuzzyMatch` over a document.
The hazard there is the fuzzy tier assembling a "match" from characters scattered across unrelated words, so the tier rejects any assembly covering less than 18% of the span it stretches across (`DENSITY_FLOOR` in [`src/fuzzy.ts`](../src/fuzzy.ts)).
The constant comes out of a measurement: with the floor disabled, this probe collects 570 junk chains across both corpora at every length, maxing out at _0.143_ density, while the sparsest genuine match (initials scattered across a four-word name) measures _0.211_; 0.18 splits the gap with margin both ways.

The probe: the document is the mixed corpus joined with spaces and sliced to graded lengths; queries are 40 real corpus words verified absent from the largest slice (no substring anywhere), so any hit is the fuzzy tier assembling a junk chain.

<!-- bench:longtext -->
| doc chars | junk rate | present hits | miss ms |
|----------:|----------:|-------------:|--------:|
|        64 |        0% |          8/8 |   0.007 |
|       128 |        0% |        15/15 |   0.007 |
|       256 |        0% |        20/20 |   0.011 |
|       512 |        0% |        20/20 |   0.014 |
|      1024 |        0% |        20/20 |   0.036 |
|      2048 |        0% |        20/20 |   0.044 |
|      4096 |        0% |        20/20 |   0.075 |
|      8192 |        0% |        20/20 |   0.142 |
|     16384 |        0% |        20/20 |   0.280 |
<!-- bench:end -->

Zero junk at every length, while every genuinely present word still matches (a present word is a substring, so `contains` needs no fuzzy assembly) and label-corpus behaviour is unchanged (same MRR, same ranks, slightly tighter sets: `rsaw` 8 → 7, ascii's `sgh` 55 → 31).
Miss cost includes the one-edit rescues (a miss must fail those too), which is what a document-length miss pays for the typo rescues on labels; it stays under a third of a millisecond at 16k chars.
Residual exposure is the adjacent-word assembly (`zebra` over "zero … branch", density 0.38), structurally identical to wanted word-start matches like `hewo` → "hello world" (0.5), so no floor separates them; they need adjacency by luck, and they rank last when they occur.
Literal-only matching, for callers that want no fuzzy assemblies at all, is a one-line `tier` filter.
[`bench/longtext.test.ts`](../bench/longtext.test.ts) keeps this table as a regression guard, asserting the junk rate is exactly zero at every length.

## The recommendation

Everything above condenses to one recommendation: _pick Krino for list matching_, with two carve-outs the data supports.
Three things carry the claim, each measured in its own section:

- **Quality**: Krino (acronym) tops the scorecard on both corpora (0.84 mixed / 0.77 ascii), with the smallest result sets of the subsequence engines (median 7 rows on structured queries where Fuse.js ships ~90).
- **Cost**: the cheapest query of anything that ranks above 0.6 MRR on either corpus; uFuzzy and fuzzysort are cheaper still, at 0.42 and 0.54 MRR against Krino's 0.80; on ascii uFuzzy ties it (the second carve-out below). A ~3 ms index at 10k (~47 ms at 100k), ~3.1 kB gzip, zero deps. The frontend Pareto frontier is Krino; the backend frontier runs through it.
- **Long text**: the density floor holds `fuzzyMatch` junk at 0% at every measured document length, so the same engine covers documents, not just labels.

The carve-outs:

- **Typo tolerance beyond a single edit.** The one-edit tiers rescue every single-character typo (transposition, insertion, deletion and substitution) at rank 1 with a single row, but _two or more_ edits in one query still need real edit distance, and Krino deliberately refuses deep scatter ("the fuzzy limit").
  If user-typed queries over messy data must match through those, Fuse.js (Bitap) or fast-fuzzy (edit distance) is the right tool; the scorecard prices what that buys and costs: 0.75/0.55 MRR on mixed, ~6–18 ms per query, ~90–450-row result sets.
- **Raw throughput at 100k+, one query at a time.** uFuzzy is ~1.6× faster per query on ascii (2.24 vs 3.57 ms), and it keeps no index, so its cold one-shot is a small fraction of Krino's ("Reading the speed numbers"). On mixed with both folding it is Krino that leads (2.24 vs 2.73 ms), so this carve-out is an ascii-corpus one.
  If query throughput is the binding constraint and a bare index array is enough output, take uFuzzy. It costs 0.38 MRR against Krino's 0.77 on ascii, so this is a real trade rather than a free win.
  Typing narrows the gap rather than closing it: the session probe shows the prefix cache bringing Krino level with uFuzzy's flat ~2.6 ms by the end of a word (2.65 vs 2.60 on `grady`), inside the tie band but no longer ahead of it.

The rest of the field is dominated on these benchmarks:

- **@nozbe/microfuzz**: Krino's parent; same subsequence approach, ~5–6× slower, 2–17× larger result sets, no tier output. Its 0.59 mixed MRR sits 21 points under base Krino: it returns nothing at all on the insertion and substitution probes.
- **fuzzysort**: fast queries but a hidden process-wide prepare cache (see "Three preparation strategies"), and prefix-biased ranking that sinks plain-word and infix ranks (20th on `ergonomic`, 13th on `gonom`).
- **match-sorter**: tiered ranking but no ranges and no multi-word; never places best on any probe, 0.31–0.41 MRR at mid-pack speed.
- **fuzzy**: substring-only and order-sensitive; 0 matches on the reversed phrase, no folding, no ranges.
- **fast-fuzzy**: the heaviest build (~660 ms at 100k) and slowest queries on these corpora; its trie rewards shared-prefix data, which natural-language corpora don't provide.

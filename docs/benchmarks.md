# Benchmarks: match quality and speed

Full data behind the README's summary: what each library calls a match, where it ranks the right answer, and what a query costs.
Every measured table below is generated, and `pnpm bench` regenerates all of them: it measures, writes [`bench/results.json`](../bench/results.json), rewrites each table in place, and redraws the Pareto charts.
No measured cell in this document is typed by hand.

- `pnpm bench --docs` re-emits the tables from the committed `results.json` without measuring anything.
- `pnpm bench --check` exits nonzero if any table here disagrees with `results.json`.
- `pnpm bench --speed` and `pnpm bench --quality` run one half of the measurement; `--runs=N` sets the fresh processes per cold cell (default 5, publish runs use 10).
- `pnpm bench --scope=mixed-10k` scopes a dev run (tokens: a corpus, a size, or `corpus-size`, comma-separable). A scoped run measures a partial matrix, so it prints and stops: neither `results.json` nor this document is touched.

The pre-filter funnel ([`bench/funnel.test.ts`](../bench/funnel.test.ts)) is a diagnostic rather than a published table; run it with `pnpm --filter=krino-bench test`.
Index memory is a diagnostic too ([`bench/memory.ts`](../bench/memory.ts), `node --expose-gc bench/memory.ts`): it measures what each configuration's index retains at 100k, in a fresh process per cell, and what survives dropping the searcher.
It is not published because the answer is uninteresting in the way that matters — every library reclaims its index within the harness's ~0.1 MB resolution floor.
The single exception is by design rather than a defect: fuzzysort's `prepare()` cache is process-wide and unevicted, so its footprint is permanent process cost until you call its `cleanup()`.
Improvements to the benchmarks are welcome.

## Libraries

The eight libraries compared throughout, and the configurations every table below is named after.
Feature coverage first; each cell is verified against the library's current source:

| Library                                                     | Per-field | Ranges | Diacritics | ESM | Multi-word | Typos | Tiers |
| ----------------------------------------------------------- | :-------: | :----: | :--------: | :-: | :--------: | :---: | :---: |
| **Krino**                                                   |    🟢     |   🟢   |     🟢     | 🟢  |     🟢     |  🟢   |  🟢   |
| [@nozbe/microfuzz](https://github.com/Nozbe/microfuzz)      |    🟢     |   🟢   |     🟢     | 🔴  |     🟢     |  🔴   |  🔴   |
| [fast-fuzzy](https://github.com/EthanRutherford/fast-fuzzy) |    🟢     |   🟡   |     🔴     | 🟢  |     🔴     |  🟢   |  🔴   |
| [Fuse.js](https://www.fusejs.io/)                           |    🟢     |   🟡   |     🟡     | 🟢  |     🟡     |  🟢   |  🔴   |
| [fuzzy](https://github.com/mattyork/fuzzy)                  |    🔴     |   🟡   |     🔴     | 🔴  |     🔴     |  🔴   |  🔴   |
| [fuzzysort](https://github.com/farzher/fuzzysort)           |    🟢     |   🟢   |     🟢     | 🔴  |     🟢     |  🔴   |  🔴   |
| [match-sorter](https://github.com/kentcdodds/match-sorter)  |    🟢     |   🔴   |     🟢     | 🟡  |     🔴     |  🔴   |  🟢   |
| [uFuzzy](https://github.com/leeoniya/uFuzzy)                |    🔴     |   🟢   |     🟡     | 🟡  |     🟡     |  🟡   |  🔴   |

🟢 built-in / on by default

🟡 opt-in or partial

🔴 not supported

Size and type, by bundle size ascending.

<!-- bench:libraries -->
| Library          | Gzip    | Deps | Type                 |
|------------------|---------|------|----------------------|
| **Krino**        | ~5.5 kB | 0    | subsequence (tiered) |
| fuzzy            | ~0.8 kB | 0    | substring            |
| @nozbe/microfuzz | ~1.7 kB | 0    | subsequence          |
| match-sorter     | ~3.4 kB | 2    | subsequence (tiered) |
| fuzzysort        | ~3.7 kB | 0    | subsequence          |
| uFuzzy           | ~4.1 kB | 0    | subsequence          |
| Fuse.js          | ~9.3 kB | 0    | typo-tolerant        |
| fast-fuzzy       | ~11 kB  | 1    | typo-tolerant        |
<!-- bench:end -->

An "(all opts)" row in the corpus tables shares its base library's size, deps, and type.
Krino's opt-in row is labelled **(acronym)** instead: `acronym: true` is its only matching opt-in, so the honest name is the specific one.
The specific opt-ins the "(all opts)" rows switch on, and where output shapes differ:

- `Krino`: Typos 🟢 is the always-on one-edit rescue, reported as the `corrected` tier — a swap, an extra character, a missing one or a wrong one, i.e. Damerau-Levenshtein distance 1, not general edit distance
- `uFuzzy`: folds diacritics via `latinize()`, matches multi-word via `outOfOrder`, and runs its one-typo `SingleError` mode with all four edits, the closest config to Krino's one-edit rescue
- `Fuse.js`: returns `ranges` via `includeMatches`, folds diacritics via `ignoreDiacritics`, and matches multi-word via `useExtendedSearch`, which turns space-separated terms into an AND of fuzzy patterns in any order — the same result set Krino's multi-word tier returns. Fuse's other multi-word switch, `useTokenSearch`, defaults to OR (`tokenMatch: "any"`) and only reaches these semantics at `tokenMatch: "all"`
- `fast-fuzzy`: its `ranges` are one span (`index` + `length`), not per-character, and its default normalisation doesn't strip accents
- `fuzzy`: its "ranges" are a pre-wrapped string, not numeric indices

Every configuration is defined once, in [`bench/configs.ts`](../bench/configs.ts), so a row timed in the speed tables is the same row ranked in the scorecard.
A base row is the library's own defaults, with two departures, both for Fuse, and both because its defaults measure worse on every axis published here.
`ignoreLocation` is on: left off, Fuse decays a match's score with its distance from index 0, which for a list of names is a positional handicap rather than a matching one.
`threshold` is 0.4 rather than the default 0.6: at 0.6 Fuse loses ascii MRR (0.61 to 0.58), runs 49% slower, and returns 6,951 of the 10,000 items for the five-character `auxen` probe.

## How to read these numbers

The methodology lives here, once; the result sections point back to it instead of re-explaining.

### One measurement model: process-cold

Every time cell in this document comes from [`bench/run.ts`](../bench/run.ts): a **fresh node process per sample**, so the JIT, every per-searcher cache, and every process-wide cache (fuzzysort's prepare pool) start empty by construction — nothing is reconstructed by arithmetic, and no harness state can leak between cells.
Each child times:

- **index** = the constructor call, whatever the configuration builds there (uFuzzy (all opts) latinizing the haystack included; fuzzysort has no constructor at all, so its prepare-all pass lands in its first query, which is where a real user pays it).
- **cold query** = the first answer to the probe — every lazy slice unpaid: krino's raw-gate scan and rescue mask build, microfuzz's first-search slice, fuzzysort's prepare-all.
- **batch** = one process answering a short-word warmup match (`grady`-shaped: guaranteed literal hit, absorbs the JIT and the first full scan) and then all twenty probes, once each: the realistic session. Warmth here is earned only by answering distinct real queries — no query is ever repeated, anywhere in the harness. The batch reports its total, the warmup (`first`), the mean of the twenty (`batch/query`), and each probe's own post-warmup time, which the per-probe tables show as **batch ms**.
- **one-shot** = constructor + first answer, summed inside one child's consecutive windows: the full price of "given a list, get an answer".

The JIT is included deliberately.
A cold first call runs unoptimised code, and that is exactly what a user's first call runs; by the twentieth distinct query the engine is as warm as a real session ever makes it.
The previous harness sampled hundreds of repeats of one query, which tiered the JIT far past anything realistic and hid every first-call cost inside an untimed calibration probe — [docs/measurement.md](./measurement.md) records the move.

Which column matters depends on workload: search-as-you-type → **batch/query** (and the session table below for the keystroke chain); a backend one-shot over fresh data → **one-shot**; a first-keystroke latency budget over a prebuilt index → **cold query**.

### Timing method

**Medians across fresh processes, published; minimums kept.**
Timing noise is one-sided (GC, scheduler, and thermal interruptions only ever _add_ time), so the median across processes rejects spikes; the per-cell minimum — the noise-free floor — stays in [`bench/results.json`](../bench/results.json) but is never the headline, because best-of-N flatters.
Five processes per cell is the dev default and ten the publish setting (`pnpm bench --runs=N`): every number is milliseconds-scale under this model, so a handful of process samples resolves it — the old hundreds-of-samples machinery existed only to resolve steady-state microseconds that no real user ever sees.

Four guards keep a run honest:
result counts must be identical across a cell's processes (a variant whose answer drifts is not timing comparable work);
variant order rotates per repetition so thermal and load drift land evenly instead of on whichever library ran last;
base Krino measuring slower than its strictly-more-code acronym configuration fails the run outright (more code cannot be faster — a violated invariant means absorbed load, and the artifact is not written);
and the first cell is re-timed after the last as a drift canary.

Numbers are expected to vary per machine: swapping between a Mac ARM host and an AMD x64 showed subtly different relative results.

### The corpus and the twenty probes

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

| #     | probe                         | query                     | isolates                                              |
| ----- | ----------------------------- | ------------------------- | ----------------------------------------------------- |
| 1     | long single word              | `ergonomic`               | baseline agreement; rank on a common word             |
| 2     | short single word             | `grady`                   | low-signal input, fewer chars for gates and chunking  |
| 3     | two-word phrase               | `handcrafted wooden`      | tokenization (in corpus order: any engine can pass)   |
| 4     | two words, reversed           | `wooden handcrafted`      | true order-independence, substring engines get 0      |
| 5     | two words, first mistyped     | `handcxafted wooden`      | a typo inside a phrase; word-level rescue             |
| 6     | two words, second mistyped    | `handcrafted wooxen`      | the rescue must find the failing word, not assume it  |
| 7     | reversed phrase, one mistyped | `wooden handcxafted`      | the correction must survive order-independence        |
| 8     | two words, both mistyped      | `handcxafted wooxen`      | two edits: refusal beats guessing (unscored)          |
| 9     | plural typed, singular stored | `romanowskis`             | a trailing `-s` the corpus lacks — one deletion       |
| 10    | prefix / partial word         | `auxen`                   | precision at a near-unique singleton                  |
| 11    | mid-word infix                | `gonom`                   | contains-anywhere vs start-anchored ranking           |
| 12–14 | typo gradient (light → heavy) | `hugutte` `huuete` `hget` | each engine's effective fuzzy limit                   |
| 15    | transposition typo            | `hugeutte`                | adjacent-swap handling, rescue tier vs edit distance  |
| 16    | insertion typo                | `hugueette`               | a doubled keystroke, one character too many           |
| 17    | substitution typo             | `huguxtte`                | one wrong character, absent from the source entirely  |
| 18    | acronym                       | `rsaw`                    | deliberate acronym support vs accidental subsequences |
| 19    | accent-stripped               | `kepa`                    | diacritic folding                                     |
| 20    | garbage                       | `qxzwkv`                  | the reject path, verifying no impossible matches      |

Twenty queries aren't a workload: they can't estimate throughput or tail latency (the speed tables and the session probe below do that); they are chosen to make every library's matching _policy_ visible in one screen of tables, with each library given at least one probe where its specialty should win (token engines take the reversed phrase, folding engines the accent probe, edit-distance engines the three single-edit typo probes).
MRR over eighteen scored queries is correspondingly coarse: read differences of ±0.02 as ties.

## Build cost

<!-- bench:build -->
| build |   Krino | @nozbe/microfuzz | fast-fuzzy | Fuse.js | uFuzzy (all opts) |
|-------|--------:|-----------------:|-----------:|--------:|------------------:|
| 10k   | 0.14 ms |          4.35 ms |   40.03 ms | 1.63 ms |           6.81 ms |
| 100k  | 0.30 ms |         53.95 ms |  394.48 ms | 6.93 ms |          11.60 ms |
<!-- bench:end -->

Measured on the mixed corpus (process-cold constructor timings; build cost barely differs between corpora).
Fuse.js's near-free build is the flip side of its slow queries: its "index" is trivial and the work is deferred to query time.
fast-fuzzy's trie is the opposite trade: the heaviest build in the set buys its subtree pruning.
fuzzysort has no constructor at all, so it has no column here — its lazy prepare-all pass lands in its first query's cold cell, where stock usage actually pays it.
uFuzzy's ~6 ms base construction is a process-cold discovery of its own: `new uFuzzy()` compiles the engine's regex machinery on first construction (a second construction costs 0.03 ms), so "keeps no index" is true per item but not per process — the base cell is near-identical at 10k and 100k, which is the proof it never touches the list; the (all opts) column shown here also latinizes the haystack, which is why it grows with the corpus (6.8 → 11.6 ms).
microfuzz's column is its eager constructor; its lazy first-search slice shows up in the cold cells instead.
Krino's constructor only allocates — field text is trimmed, normalised and masked the first time an item survives a gate — so a 100k list swap costs about a millisecond, and the first query then carries what construction deferred (its cold cells).

## Match quality, probe by probe

Each library has its own definition of a match, so raw outputs aren't directly comparable.
To surface the differences, the twenty probes run against every library; queries are from the mixed corpus at 10k.
One small table per query:

- **rank** = where the queried item placed (1 = top hit; ✗ = matched other things but lost the source; — = returned nothing)
- **matches** = how many of the 10,000 items the library returned
- **index ms** = the constructor call, in the same fresh process
- **cold ms** = the first answer to this query in a fresh process — JIT, caches and lazy slices all genuinely cold
- **total ms** = index + cold, summed inside each child's consecutive windows: the cold one-shot for this exact query
- **batch ms** = this probe's time inside the batch run — after the warmup match, mid-session, lazy costs landing on whichever probe triggers them

Every cell is process-cold ("One measurement model"), so the per-probe tables show exactly which query shapes make each library pay: krino's rescue mask build appears on the typo probes and nowhere else, fuzzysort's prepare-all on every first call.
Magnitude only; the rigorous timings are the speed tables below.

Each library appears once, at its base configuration.
Its "(all opts)" row joins it only on the probes where the opt-ins moved the source's rank inside the top ten, so a table that widens is a table where switching those options on changed whether, or where, a picker would show the item.
Deep-rank wobble doesn't qualify: rank 142 and rank 145 are both invisible, and the difference between them is not a row.

Two scorecard libraries are left out of the per-query tables to keep them readable.
fuzzy behaves like a less capable microfuzz: identical ranks on the plain-word, two-word, prefix, and light-typo probes; it drifts on the deep-typo and acronym probes, returns nothing on the reversed-phrase probe (order-sensitive), and misses the accent probe outright (no folding).
match-sorter never places best on any query: some shown library always matches or beats it.
Both keep full per-query cells in [`bench/results.json`](../bench/results.json).
The garbage query `qxzwkv` gets a table of its own instead: it returns 0 everywhere, so there is no rank to report, but what it costs to return nothing is the whole point of the probe.

### long word: `ergonomic`

<!-- bench:probe-long-word -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    1 |      76 |     0.14 |    2.86 |     3.00 |     2.23 |
| @nozbe/microfuzz |    1 |      76 |     4.28 |    2.30 |     6.54 |     2.13 |
| fast-fuzzy       |   13 |      82 |    40.28 |   19.00 |    58.88 |    12.19 |
| Fuse.js          |    1 |      81 |     1.59 |   21.12 |    22.78 |    17.89 |
| fuzzysort        |   20 |      76 |     0.04 |    7.63 |     7.67 |     1.21 |
| uFuzzy           |   29 |      76 |     6.21 |    1.36 |     7.60 |     0.48 |
<!-- bench:end -->

The subsequence libraries agree on the set (76); the typo engines add a handful (81–82). The speed comparison is meaningful because they are returning near enough the same thing.
Rank is the differentiator: Krino/microfuzz put the source first; fuzzysort and uFuzzy sink it to 20th–29th.

### short word: `grady`

<!-- bench:probe-short-word -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    1 |      19 |     0.15 |    2.61 |     2.75 |     0.77 |
| @nozbe/microfuzz |    1 |      36 |     4.44 |    2.20 |     6.61 |     2.48 |
| fast-fuzzy       |    2 |     382 |    42.11 |   19.75 |    61.86 |    11.48 |
| Fuse.js          |    1 |     375 |     1.65 |   13.15 |    14.80 |    10.63 |
| fuzzysort        |    2 |      36 |     0.04 |    7.53 |     7.58 |     0.53 |
| uFuzzy           |    2 |      19 |     6.42 |    1.36 |     7.78 |     0.26 |
<!-- bench:end -->

A second plain-word probe from elsewhere in the corpus. Krino ranks the source first, as on the long word, and matches uFuzzy's 19-row set — the tightest here — because the one-edit rescue stops once ten literal hits fill the page, so a query this ordinary pays for no corrections.

### two words: `handcrafted wooden`

<!-- bench:probe-two-words -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    1 |       5 |     0.14 |    4.27 |     4.41 |     3.46 |
| @nozbe/microfuzz |    1 |       5 |     4.26 |    2.21 |     6.46 |     1.95 |
| fast-fuzzy       |    1 |      95 |    38.42 |   17.23 |    56.60 |    10.69 |
| Fuse.js          |    1 |      95 |     1.69 |   44.71 |    46.36 |    40.36 |
| fuzzysort        |    1 |       5 |     0.04 |    7.36 |     7.40 |     0.66 |
| uFuzzy           |    2 |       5 |     6.10 |    1.19 |     7.25 |     0.25 |
<!-- bench:end -->

Five items contain both words; every subsequence library returns exactly those five.
The typo engines return 19× that, and Fuse.js takes ~45 ms cold to do it (its extended-search tokenization is the most expensive path here).
One caveat on the agreement: the phrase is in corpus order, so it is a contiguous substring of the source: engines with no tokenization at all pass this probe for free.
The next probe removes that shortcut.

### two words, reversed: `wooden handcrafted`

<!-- bench:probe-two-words-reversed -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       5 |     0.14 |    4.30 |     4.45 |     0.76 |
| @nozbe/microfuzz  |    1 |       5 |     4.37 |    2.10 |     6.50 |     1.70 |
| fast-fuzzy        |    5 |      76 |    40.34 |   16.54 |    56.65 |     8.39 |
| Fuse.js           |    1 |      76 |     1.62 |   43.61 |    45.23 |    39.89 |
| fuzzysort         |    1 |       5 |     0.04 |    7.29 |     7.33 |     0.49 |
| uFuzzy            |    — |       0 |     6.13 |    0.86 |     6.99 |     0.22 |
| uFuzzy (all opts) |    2 |       5 |     6.82 |    4.18 |    10.98 |     0.97 |
<!-- bench:end -->

These are the same two words in the opposite order, so this is the probe that actually isolates tokenized matching.
The tokenizing engines keep exactly the five items at rank 1; uFuzzy's default (in-order terms), match-sorter, and fuzzy all drop to _0 matches_ on a query a user would type without thinking.
(fuzzysort passes not by tokenizing but by chaining subsequences; the same permissiveness that costs it elsewhere happens to cover word order.)

### two words, one mistyped: `handcxafted wooden`

<!-- bench:probe-two-words-typo -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       5 |     0.14 |    3.97 |     4.11 |     0.43 |
| @nozbe/microfuzz  |    — |       0 |     4.32 |    2.01 |     6.32 |     2.54 |
| fast-fuzzy        |    1 |      95 |    36.00 |   17.54 |    53.73 |    10.18 |
| Fuse.js           |    1 |      95 |     1.62 |   44.85 |    46.53 |    39.79 |
| fuzzysort         |    — |       0 |     0.04 |    7.01 |     7.05 |     0.39 |
| uFuzzy            |    — |       0 |     6.15 |    0.84 |     6.99 |     0.21 |
| uFuzzy (all opts) |    2 |       5 |     6.80 |    3.55 |    10.38 |     2.20 |
<!-- bench:end -->

The same phrase with one character wrong in the first word.
This used to be the probe Krino did not answer — a fifteen-character query offers fifteen substitution positions to guess from, and the old restriction to single-word queries is what stopped the rescue inventing matches at that width.
The multi-word rescue reaches it without reopening that hazard by inverting the search: the words that _do_ occur literally pin the candidate fields first, and only the one failing word is corrected, over that handful of fields rather than the corpus.
The three probes after this one stress the same mechanism from each side — the typo in the other word, the phrase reversed, and both words wrong at once, where refusing is the only right answer.

### two words, second mistyped: `handcrafted wooxen`

<!-- bench:probe-two-words-typo-second -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       5 |     0.15 |    3.96 |     4.11 |     0.32 |
| @nozbe/microfuzz  |    — |       0 |     4.28 |    1.98 |     6.26 |     1.37 |
| fast-fuzzy        |    1 |      88 |    42.75 |   17.05 |    60.54 |     8.65 |
| Fuse.js           |    1 |      88 |     1.67 |   45.99 |    47.62 |    39.96 |
| fuzzysort         |    — |       0 |     0.04 |    7.13 |     7.17 |     0.41 |
| uFuzzy            |    — |       0 |     6.34 |    0.83 |     7.16 |     0.18 |
| uFuzzy (all opts) |    2 |       5 |     6.87 |    3.58 |    10.47 |     1.69 |
<!-- bench:end -->

The rescue cannot assume which word failed; it has to find it.
Engines that only tolerate edits near the query's start, or that anchor on the first token, drop the source here.

### reversed phrase, one mistyped: `wooden handcxafted`

<!-- bench:probe-two-words-typo-reversed -->
| Library            | rank | matches | index ms | cold ms | total ms | batch ms |
|--------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino              |    1 |       5 |     0.15 |    4.18 |     4.33 |     0.33 |
| @nozbe/microfuzz   |    — |       0 |     4.29 |    1.96 |     6.26 |     1.29 |
| fast-fuzzy         |    — |       0 |    41.92 |   14.03 |    55.81 |     9.37 |
| Fuse.js            |    — |       0 |     1.67 |   43.27 |    45.02 |    40.44 |
| Fuse.js (all opts) |    1 |       5 |     1.66 |   18.51 |    20.25 |    14.24 |
| fuzzysort          |    — |       0 |     0.04 |    6.98 |     7.02 |     0.41 |
| uFuzzy             |    — |       0 |     6.09 |    0.85 |     6.95 |     0.21 |
| uFuzzy (all opts)  |    2 |       5 |     6.84 |    4.18 |    11.02 |     0.94 |
<!-- bench:end -->

Both hard axes at once: the words are out of corpus order _and_ one of them is mistyped, so a substring engine has nothing to hold on to and an in-order typo engine loses the phrase.
The corrected phrase must still match through the order-independent multi-word tier.

### two words, both mistyped: `handcxafted wooxen`

<!-- bench:probe-two-words-double-typo -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    — |       0 |     0.14 |    3.37 |     3.51 |     0.27 |
| @nozbe/microfuzz |    — |       0 |     4.32 |    2.01 |     6.30 |     1.39 |
| fast-fuzzy       |    ✗ |      88 |    42.33 |   16.69 |    59.40 |     7.96 |
| Fuse.js          |    ✗ |      88 |     1.72 |   45.90 |    47.66 |    39.63 |
| fuzzysort        |    — |       0 |     0.04 |    6.96 |     7.00 |     0.30 |
| uFuzzy           |    — |       0 |     6.13 |    0.84 |     6.97 |     0.19 |
<!-- bench:end -->

Two edits in one phrase, so no one-edit rescue can explain it, and like the garbage probe there is no rank column that matters: the honest answer is nothing.
Krino must return 0 here — anything else means the rescue guessed — while the edit-distance engines legitimately match it, at their usual candidate-set width.
[`bench/hits.test.ts`](../bench/hits.test.ts) pins the refusal as an assertion, the same way the garbage probe is pinned.

### plural typed, singular stored: `romanowskis`

<!-- bench:probe-plural-to-singular -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       2 |     0.14 |    6.58 |     6.73 |     1.22 |
| @nozbe/microfuzz  |    — |       0 |     4.42 |    2.40 |     6.74 |     1.40 |
| fast-fuzzy        |    1 |      53 |    39.68 |   18.77 |    57.31 |     7.29 |
| Fuse.js           |    1 |      51 |     1.77 |   25.54 |    27.23 |    21.04 |
| fuzzysort         |    — |       0 |     0.05 |    7.79 |     7.84 |     0.25 |
| uFuzzy            |    — |       0 |     6.40 |    0.90 |     7.30 |     0.24 |
| uFuzzy (all opts) |    1 |       2 |     7.08 |    2.66 |     9.74 |     1.52 |
<!-- bench:end -->

A trailing `s` the corpus does not hold, which is one deletion and therefore exactly what the one-edit rescue exists for.
The subsequence engines return _0_: a plural is not a subsequence of its singular, because the trailing character has nothing left to match.
Only edit-distance matching reaches it, and Krino and uFuzzy's SingleError configuration both land the source at rank 1 from two candidates — uFuzzy's own default finds nothing.
fast-fuzzy and Fuse.js also rank it first, from 53 and 51 candidates, twenty-five times the set for the same answer.
Only the `-s` plural is reachable this way: `-es`, `-ves` and `-ies` are two or three edits, and no rescue tiering closes that without a stemmer.

### prefix: `auxen`

<!-- bench:probe-prefix -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    1 |      16 |     0.14 |    6.89 |     7.03 |     1.46 |
| @nozbe/microfuzz |    1 |       1 |     4.38 |    2.31 |     6.70 |     1.48 |
| fast-fuzzy       |    1 |     452 |    45.64 |   20.86 |    66.54 |     6.44 |
| Fuse.js          |    1 |     444 |     1.63 |   13.23 |    14.85 |    10.25 |
| fuzzysort        |    1 |       1 |     0.05 |    7.38 |     7.43 |     0.23 |
| uFuzzy           |    1 |       1 |     6.26 |    1.18 |     7.43 |     0.30 |
<!-- bench:end -->

One item matches this prefix literally, and the pure subsequence engines return exactly it.
Krino returns 16 because its one-edit rescue also admits the corrections of `auxen`, all scored below the literal `prefix` hit that takes rank 1. The always-on typo tolerance costs a wider set on a query that did not need it.
The typo engines are the other end of that trade, ~450 candidates for the same one true hit.

### infix: `gonom`

<!-- bench:probe-infix -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    5 |      76 |     0.14 |    2.59 |     2.73 |     0.51 |
| @nozbe/microfuzz |    5 |      88 |     4.46 |    2.37 |     6.83 |     1.44 |
| fast-fuzzy       |   14 |     197 |    41.77 |   19.56 |    61.88 |     5.67 |
| Fuse.js          |    5 |     174 |     1.68 |   12.76 |    14.52 |     9.62 |
| fuzzysort        |   13 |      88 |     0.04 |    7.78 |     7.82 |     0.59 |
| uFuzzy           |   58 |      76 |     6.11 |    1.37 |     7.46 |     0.36 |
<!-- bench:end -->

A mid-word slice of "ergonomic", so nothing can prefix-match: this probe separates contains-anywhere ranking from start-anchored ranking.
Krino, microfuzz and Fuse.js agree on rank 5 — four items outrank the source legitimately — while the start-anchored rankers sink it (fuzzysort 13th, uFuzzy 58th).

### the fuzzy limit: `hugutte` / `huuete` / `hget`

Three probes degrade one source word ("Huguette", near-unique in the corpus) in steps: **light** drops one middle char (`hugutte`, a sloppy keystroke), **medium** drops every third char (`huuete`), **heavy** keeps only every other char (`hget`, 1–2 char fragments).
Where a library stops surfacing the source is its effective fuzzy limit.

**light (`hugutte`):**

<!-- bench:probe-scatter-light -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       1 |     0.14 |    6.09 |     6.23 |     0.84 |
| @nozbe/microfuzz  |    1 |       5 |     4.29 |    2.21 |     6.50 |     1.18 |
| fast-fuzzy        |    1 |       1 |    37.96 |   17.41 |    56.02 |     5.38 |
| Fuse.js           |    1 |       1 |     1.65 |   15.58 |    17.25 |    10.38 |
| fuzzysort         |    1 |       5 |     0.04 |    7.44 |     7.49 |     0.30 |
| uFuzzy            |    — |       0 |     6.07 |    0.84 |     6.92 |     0.21 |
| uFuzzy (all opts) |    1 |       1 |     6.87 |    1.88 |     8.74 |     0.87 |
<!-- bench:end -->

**medium (`huuete`):**

<!-- bench:probe-scatter-medium -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    1 |       1 |     0.14 |    6.21 |     6.35 |     0.78 |
| @nozbe/microfuzz |    1 |       9 |     4.29 |    2.21 |     6.49 |     1.20 |
| fast-fuzzy       |    1 |      26 |    39.09 |   17.97 |    57.06 |     5.60 |
| Fuse.js          |    3 |      26 |     1.68 |   13.85 |    15.51 |     9.85 |
| fuzzysort        |    1 |       9 |     0.04 |    7.50 |     7.55 |     0.34 |
| uFuzzy           |    — |       0 |     6.10 |    0.85 |     6.93 |     0.20 |
<!-- bench:end -->

**heavy (`hget`):**

<!-- bench:probe-scatter-heavy -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    — |       0 |     0.14 |    2.40 |     2.55 |     0.35 |
| @nozbe/microfuzz |   21 |      67 |     4.24 |    2.18 |     6.38 |     1.31 |
| fast-fuzzy       |    ✗ |      24 |    39.83 |   18.47 |    59.35 |     5.04 |
| Fuse.js          |    ✗ |      24 |     1.64 |   10.00 |    11.69 |     6.30 |
| fuzzysort        |    1 |      67 |     0.04 |    7.57 |     7.61 |     0.38 |
| uFuzzy           |    — |       0 |     6.14 |    0.89 |     7.02 |     0.26 |
<!-- bench:end -->

The gradient locates each engine's limit.
Krino surfaces the source _first with exactly one row_ through light and medium, then refuses outright at the heavy grade: 1–2 char fragments fail its chunking rules, and returning nothing beats returning the 67 junk chains the chain engines assemble.
microfuzz keeps matching at every level (rank 21 in 67 rows on `hget`), the behaviour Krino inherited and deliberately changed to refusal; fuzzysort even ranks the source first there, by accepting the same 67-chain noise.
The typo engines hold rank 1 on light but shed precision as the signal thins: Fuse.js slips to 3rd on medium and both lose the source at heavy (✗, 24 junk rows).
uFuzzy's default tolerates no intra-word gaps at all, 0 at every level.

### the transposition: `hugeutte`

<!-- bench:probe-transposition -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       1 |     0.15 |    5.89 |     6.05 |     0.60 |
| @nozbe/microfuzz  |    ✗ |       2 |     4.25 |    2.24 |     6.51 |     1.25 |
| fast-fuzzy        |    1 |       6 |    41.65 |   18.99 |    61.05 |     5.81 |
| Fuse.js           |    1 |       6 |     1.68 |   18.37 |    20.13 |    14.02 |
| fuzzysort         |    ✗ |       2 |     0.04 |    7.48 |     7.52 |     0.23 |
| uFuzzy            |    — |       0 |     6.10 |    0.84 |     6.94 |     0.19 |
| uFuzzy (all opts) |    1 |       1 |     6.82 |    2.02 |     8.84 |     0.99 |
<!-- bench:end -->

The fourth typo probe degrades the same source word along a different axis: two adjacent characters swapped (`huguette` → `hugeutte`), same character count, wrong order.
Deletions leave a query that is still a subsequence of its source; a transposition does not, so no subsequence _chain_ can represent it: microfuzz and fuzzysort lose the source (✗; their two "matches" are other items the letters happen to chain through) and uFuzzy returns 0.
Krino does not rely on subsequence here: after every tier in the ladder misses, a dedicated rescue retries each single-edit correction of the query and accepts only real-tier hits, scored as the corrected query's tier + 2.1 (tier `corrected`).
That surfaces the source _first, with exactly one row_. The edit-distance engines also rank it first but arrive with 6 candidates.
The penalty is sized so that even the best correction sorts below the weakest literal tier (`contains`): a correction is a guess at what the user meant, a substring match is something they actually typed, so the literal hit always wins. Sizing it lower sinks infix ranking, because another item's guess then displaces the item the query literally appears in.
Multi-error edits (two or more) remain the edit-distance engines' territory, and the scorecard prices that boundary.

### the insertion: `hugueette`

<!-- bench:probe-insertion -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       1 |     0.14 |    5.87 |     6.01 |     0.51 |
| @nozbe/microfuzz  |    — |       0 |     4.42 |    2.18 |     6.60 |     1.27 |
| fast-fuzzy        |    1 |       1 |    40.65 |   17.36 |    57.34 |     5.63 |
| Fuse.js           |    1 |       1 |     1.60 |   20.05 |    21.76 |    14.31 |
| fuzzysort         |    — |       0 |     0.04 |    7.22 |     7.26 |     0.21 |
| uFuzzy            |    — |       0 |     6.14 |    0.84 |     6.98 |     0.18 |
| uFuzzy (all opts) |    1 |       1 |     6.93 |    2.14 |     9.08 |     1.07 |
<!-- bench:end -->

A doubled keystroke (`huguette` → `hugueette`), one character too many.
A subsequence engine cannot represent an _extra_ character at all (there is no way to skip a query character), so microfuzz, fuzzysort and uFuzzy return _0_ matches rather than ranking the source poorly.
Krino, fast-fuzzy and Fuse.js all return exactly the source, at rank 1.
Krino gets there by dropping each character of the query in turn and rerunning the ladder on the corrections (tier `inserted`), which costs it a rescue pass on this query but nothing on the queries that match literally.

### the substitution: `huguxtte`

<!-- bench:probe-substitution -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    1 |       1 |     0.15 |    5.69 |     5.83 |     0.39 |
| @nozbe/microfuzz  |    — |       0 |     4.26 |    2.13 |     6.35 |     1.07 |
| fast-fuzzy        |    1 |       1 |    40.44 |   18.40 |    58.24 |     5.66 |
| Fuse.js           |    1 |       1 |     1.77 |   20.84 |    22.61 |    14.59 |
| fuzzysort         |    — |       0 |     0.04 |    7.47 |     7.51 |     0.18 |
| uFuzzy            |    — |       0 |     6.14 |    0.84 |     6.98 |     0.18 |
| uFuzzy (all opts) |    1 |       1 |     6.91 |    2.02 |     8.94 |     0.95 |
<!-- bench:end -->

One wrong character, and deliberately one the source does not contain anywhere (`e` → `x`).
That second property is why this is the hardest of the four edits for Krino specifically: the char-class bitmask gate rejects an item missing any of the query's character classes, so a single character absent from the corpus item would otherwise eliminate it before any tier runs.
Reaching it at all required the gate to tolerate exactly one missing class, the single most expensive change in the library, because that gate is what rejects 90–100% of items on every other query (see "Reading the speed numbers").
The matcher itself is cheap: one half of the query must survive a single substitution, so the two halves' occurrences are the only windows worth testing.
Same outcome as the insertion probe. The three subsequence engines return 0, the typo-tolerant engines and Krino return exactly the source.

### acronym: `rsaw`

<!-- bench:probe-acronym -->
| Library          | rank | matches | index ms | cold ms | total ms | batch ms |
|------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino            |    2 |       7 |     0.15 |    2.75 |     2.90 |     0.45 |
| Krino (acronym)  |    1 |       8 |     0.14 |    3.05 |     3.20 |     0.48 |
| @nozbe/microfuzz |    2 |     133 |     4.27 |    2.39 |     6.65 |     1.40 |
| fast-fuzzy       |    ✗ |      28 |    41.70 |   18.56 |    60.09 |     5.15 |
| Fuse.js          |    ✗ |      28 |     1.73 |   10.25 |    11.98 |     6.46 |
| fuzzysort        |    2 |     133 |     0.04 |    8.00 |     8.05 |     0.76 |
| uFuzzy           |    — |       0 |     6.33 |    0.90 |     7.23 |     0.25 |
<!-- bench:end -->

`rsaw` is the initials of "Rath, Streich and Witting".
Krino's opt-in acronym tier ranks the source _first_ with a tight set of 8, while Krino/microfuzz/fuzzysort land it second (the chain engines by matching 133 scattered subsequences, Krino via single-char word-boundary chunks; Krino's base row shows 7: the density floor, the minimum share of the span a fuzzy assembly has to cover, drops one junk chain the acronym tier keeps as a real initials hit).
The typo engines lose the source entirely (✗); uFuzzy's defaults find nothing.
Tier semantics: apostrophes are word-internal (`People's` contributes one initial, `p`), and stopwords are not skipped (`drc` won't match "Democratic Republic of the Congo" at all: the acronym is `drotc`, and the density floor rejects the sparse `d`/`r`/`c` fuzzy chain at 0.107, under the 0.18 minimum).

### accents: `kepa`

<!-- bench:probe-accent-stripped -->
| Library           | rank | matches | index ms | cold ms | total ms | batch ms |
|-------------------|-----:|--------:|---------:|--------:|---------:|---------:|
| Krino             |    2 |       7 |     0.14 |    2.57 |     2.72 |     0.39 |
| @nozbe/microfuzz  |    2 |      70 |     4.28 |    2.05 |     6.41 |     1.07 |
| fast-fuzzy        |   33 |      82 |    40.10 |   18.97 |    59.07 |     4.93 |
| Fuse.js           |    1 |      74 |     1.64 |    8.68 |    10.32 |     6.52 |
| fuzzysort         |    2 |      70 |     0.04 |    7.60 |     7.64 |     0.37 |
| uFuzzy            |    — |       0 |     6.15 |    0.88 |     7.05 |     0.25 |
| uFuzzy (all opts) |    3 |       4 |     6.84 |    1.46 |     8.29 |     0.41 |
<!-- bench:end -->

`kepa` targets items containing "Kępa".
uFuzzy's 0 is the silent diacritics miss, and the one probe where its `latinize` opt-in is the difference between finding the item and not.
fast-fuzzy's matches come from edit distance rather than folding, which is why the source lands so deep.

### garbage: `qxzwkv`

<!-- bench:probe-miss -->
| Library          | matches | cold ms | vs `ergonomic` |
|------------------|--------:|--------:|---------------:|
| Krino            |       0 |   4.461 |           156% |
| @nozbe/microfuzz |       0 |   1.836 |            80% |
| fast-fuzzy       |       0 |  16.063 |            85% |
| Fuse.js          |       0 |  12.149 |            58% |
| fuzzysort        |       0 |   7.058 |            93% |
| uFuzzy           |       0 |   0.824 |            61% |
<!-- bench:end -->

No rank column: every library correctly returns nothing, which is the only right answer.
What separates them is the price of that answer, shown against each library's own cost for the long-word probe (a query that does match), so the column reads as "what fraction of a real query does a hopeless one cost you".
Process-cold, this probe inverted: Krino's miss costs _more_ than its hit (156%, the only ratio above 100% in the table), and the reason is diligence, not waste.
A hopeless six-character query is _rescuable_, so before saying "no results" Krino tries harder: the literal pass comes up empty, and rather than fail it builds the union and bigram masks and attempts every one-edit correction of the query — the same second pass that takes every typo probe above at rank 1 with a single row.
The engines with cheap misses are cheap because they never tried; uFuzzy's 0.8 ms refusal and Krino's 4.5 ms one bought different amounts of certainty that nothing was there.
The bill is also once per searcher, not per miss: the masks the garbage query builds are the ones every later rescue reuses, which is why the batch column absorbs it — a session's first thin query pays it and the other nineteen ride it.
(The old warm harness showed the opposite ratio, 3%, because the masks were pre-paid; both numbers are true, and the cold one is what a fresh searcher feels.)

## Scorecard

One line per configuration: MRR from [`bench/hits.test.ts`](../bench/hits.test.ts) (ranks are deterministic, measured once, untimed), costs from the process-cold matrix ("Timing method"; `pnpm bench --runs=N` sets the processes per cell).
**MRR** = mean reciprocal rank of the queried item across the 18 scored queries, with the top-10 cutoff from "The corpus and the twenty probes": misses and ranks outside the top 10 score 0.
**index ms** = the constructor call (from the batch cell's fresh processes).
**cold ms** = the mean first-answer cost across all twenty probes, each in its own fresh process.
**batch ms** = one fresh process answering a short-word warmup match and then all twenty probes once — the realistic session, whole.
**batch/query** = the mean of the twenty post-warmup probes: what a query costs once the searcher has genuinely worked.
Which column matters depends on workload: search-as-you-type → **batch/query**; backend one-shot → index + cold ("One measurement model"'s one-shot); a first-keystroke budget → **cold**.

**mixed corpus** (the query set above):

<!-- bench:scorecard-mixed -->
| Library                     |  MRR | index ms | cold ms | batch ms | batch/query |
|-----------------------------|-----:|---------:|--------:|---------:|------------:|
| Krino (acronym)             | 0.87 |     0.14 |    4.52 |    19.20 |        0.81 |
| Krino                       | 0.84 |     0.14 |    4.38 |    18.72 |        0.81 |
| Fuse.js (all opts)          | 0.81 |     1.67 |   22.90 |   360.87 |       17.11 |
| Fuse.js                     | 0.75 |     1.63 |   24.20 |   417.29 |       20.21 |
| fast-fuzzy                  | 0.59 |    40.03 |   17.96 |   169.35 |        7.41 |
| fast-fuzzy (all opts)       | 0.59 |    37.01 |   18.05 |   164.72 |        7.22 |
| uFuzzy (all opts)           | 0.52 |     6.81 |    2.38 |    22.55 |        1.04 |
| @nozbe/microfuzz            | 0.46 |     4.35 |    2.16 |    32.18 |        1.50 |
| @nozbe/microfuzz (all opts) | 0.46 |     4.24 |    2.11 |    32.60 |        1.51 |
| fuzzysort                   | 0.42 |     0.04 |    7.41 |    15.88 |        0.42 |
| fuzzy                       | 0.35 |     0.04 |    2.60 |    41.34 |        1.92 |
| fuzzy (all opts)            | 0.35 |     0.04 |    2.73 |    44.61 |        2.09 |
| match-sorter                | 0.32 |     0.04 |    7.35 |    71.16 |        3.03 |
| uFuzzy                      | 0.11 |     6.20 |    0.96 |     6.04 |        0.24 |
<!-- bench:end -->

**ascii corpus** (its own query set over its own corpus, down to its own accent probe, `cote` from "Côte d'Ivoire", which the en locale emits; MRRs therefore aren't comparable across corpora):

<!-- bench:scorecard-ascii -->
| Library                     |  MRR | index ms | cold ms | batch ms | batch/query |
|-----------------------------|-----:|---------:|--------:|---------:|------------:|
| Krino (acronym)             | 0.82 |     0.15 |    4.82 |    23.05 |        1.03 |
| Krino                       | 0.79 |     0.14 |    4.65 |    22.14 |        1.00 |
| Fuse.js (all opts)          | 0.69 |     1.73 |   21.87 |   369.88 |       17.44 |
| Fuse.js                     | 0.64 |     1.70 |   22.56 |   392.24 |       18.81 |
| @nozbe/microfuzz            | 0.52 |     4.03 |    2.20 |    34.13 |        1.60 |
| @nozbe/microfuzz (all opts) | 0.52 |     4.04 |    2.14 |    32.64 |        1.52 |
| fuzzy                       | 0.39 |     0.04 |    2.42 |    41.89 |        1.95 |
| fuzzy (all opts)            | 0.39 |     0.05 |    2.51 |    44.09 |        2.06 |
| fast-fuzzy                  | 0.39 |    40.53 |   18.44 |   168.21 |        7.49 |
| fast-fuzzy (all opts)       | 0.39 |    37.04 |   18.65 |   177.74 |        7.91 |
| uFuzzy (all opts)           | 0.39 |     6.73 |    2.13 |    19.97 |        0.91 |
| match-sorter                | 0.29 |     0.04 |    6.85 |    69.99 |        2.97 |
| fuzzysort                   | 0.28 |     0.04 |    7.11 |    17.50 |        0.52 |
| uFuzzy                      | 0.08 |     6.19 |    0.97 |     6.20 |        0.25 |
<!-- bench:end -->

Result-set size is _not_ a scorecard column: in a ranked UI any result list slices to the top N, so a large return costs a picker nothing (see "The corpus and the twenty probes").
The per-query tables above keep the raw counts for the two places size does matter: filter-style UIs that show every match, and telling whether an MRR came from a selective matcher or from ranking a huge candidate set.
_Krino (acronym) tops both corpora outright_ (0.87 mixed / 0.82 ascii), with base Krino (0.84 / 0.79) also clear of every other configuration; the nearest non-Krino row is Fuse.js (all opts) at 0.81 / 0.69.
The phrase-typo probes are what opened the gap: Krino takes all three at rank 1 with exactly the five true rows, where Fuse's base configuration loses the reversed one outright and its all-opts row arrives with ~90-row lists at ~19–46 ms cold against Krino's ~4.
On structured queries Krino returns a median of _7_ rows where Fuse ships ~90.
Base Krino leads its parent by 38 points on mixed (0.84 vs 0.46): the one-edit tiers take all three single-edit typo probes and all three phrase-typo probes at rank 1, where the subsequence engines return nothing at all on most of them.
Rank inside junk does not score, so refusal at the heavy scatter grade is cheap (microfuzz's rank-21-in-67-junk-rows on `hget` earns 0 either way; see "the fuzzy limit").
uFuzzy's typo configuration is the largest spread in the table (0.52 mixed / 0.39 ascii against 0.11 / 0.08 for its defaults), so most of what separates uFuzzy from the field on these probes comes down to configuration rather than capability.

The scorecard's cost columns are exactly what the Pareto charts draw, one per workload; both draw the mixed 10k scorecard.

**Frontend workload** (the index is built once at load, so keystrokes pay query only):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./pareto-query-dark.svg">
  <img alt="Mixed-corpus accuracy (MRR) vs. per-query cost across a twenty-query session, log scale, as a Pareto frontier. The frontier runs uFuzzy, fuzzysort, Krino, Krino (acronym): Krino (acronym) tops MRR at 0.87 at 0.81 ms per query, and everything above 0.5 MRR that isn't Krino, including Fuse.js (all opts) at 0.81 and ~17 ms, is dominated." src="./pareto-query-light.svg">
</picture>

Its x-axis is the batch's per-query cost — what a query costs once the searcher has answered nineteen real ones — and its frontier runs uFuzzy → fuzzysort → Krino → Krino (acronym).
The cheap end belongs to the bare-output engines and their MRR says why (0.11 and 0.42); nothing above 0.5 MRR comes within 25% of Krino's 0.81 ms, and everything typo-tolerant is 9–25× dearer.

**Backend one-shot workload** (a fresh process pays constructor + first answer): the chart lives in the README's Comparison section, deliberately the less flattering of the two there.
Its frontier runs `fuzzy` → Krino → Krino (acronym): a no-index substring scan at 0.35 MRR owns the cheap end, and every other configuration — uFuzzy included, once its constructor-and-first-call reality is measured rather than amortised — is dominated.
This is the ledger where Krino's lazy preparation presents its bill: the first answer carries the raw-gate scan and, on typo-shaped queries, the mask build (~4.4 ms at 10k against a 0.14 ms constructor), and the batch's `first` vs `rest` split shows the whole bill paid by query one.

_Both charts read the scorecard above out of [`bench/results.json`](../bench/results.json) ([`pareto.ts`](./pareto.ts)), so they cannot disagree with it; `pnpm bench` redraws them._

## Size, speed & search type

These tables position each library rather than rank them; the method is uniform throughout.
**Gzip** = esbuild `--bundle --minify` + gzip, tree-shaken to each lib's primary API (the size table is in [Libraries](#libraries)).
Every cell is process-cold ("One measurement model"), and each corpus gets two tables.
The scale table is the one-shot ledger: **index** = the constructor, **cold query** = mean first answer across the twenty probes (each in its own fresh process), **total** = the mean of constructor + first answer, summed inside each probe's own child, **total rel** = that total relative to Krino (100% = same, lower = faster).
The batch table is the session ledger: **batch total** = one fresh process answering a short-word warmup match then all twenty probes once, **batch/query** = the mean of the twenty post-warmup probes, **batch rel** = batch total relative to Krino.
The aggregate row is a **geometric mean**: per-library times span orders of magnitude, so an arithmetic mean would only describe the slowest library; the geomean is the standard aggregate for multiplicative spreads, and the rel cells are equally the geomean of each rel column (a geomean of ratios is the ratio of geomeans).
These tables publish the 100k size; the full 10k matrix — scorecard and per-probe tables — carries the fine-grained view, and every cell of both sits in [`bench/results.json`](../bench/results.json).
The two corpora are described in "The corpus and the twenty probes"; they're benched separately.
The mixed table only lists configurations that fold diacritics, i.e. actually do that corpus's task (cross-checked per query by [`bench/hits.test.ts`](../bench/hits.test.ts)); a fast non-folding row would be fast at a different, easier job, so those are omitted and named below the table.
The **_all libraries_** row is the corpus-wide view: the geometric mean of every shown configuration at that size.
**(all opts)** rows switch on every opt-in the library has: diacritic folding, multi-word, highlight/ranges output, and typo modes; base rows are stock defaults, and [Libraries](#libraries) itemizes which opt-in is which.
Typo modes are included because Krino's one-edit matching is always on and cannot be disabled, so holding another engine's typo mode off would time two engines doing different jobs.
Only uFuzzy is affected in practice. Fuse.js (Bitap) and fast-fuzzy (edit distance) are typo-tolerant in every configuration here.
Every child consumes its result counts, the runner asserts they are identical across a cell's processes, and [`bench/hits.test.ts`](../bench/hits.test.ts) records per-library match counts for every query — so the timings above are known to be timing comparable work.
Per-cell minimums and heap footprints are in [`bench/results.json`](../bench/results.json).
Krino leads its own table; the rest are alphabetical, so each library's base and (all opts) rows sit together and nothing is ordered by how well it did.

### ascii corpus

<!-- bench:speed-ascii -->
| Library                     |     index | cold query |     total | total rel |
|-----------------------------|----------:|-----------:|----------:|----------:|
| **Krino**                   |   0.33 ms |   17.81 ms |  18.12 ms |  **100%** |
| Krino (acronym)             |   0.32 ms |   18.13 ms |  18.46 ms |      102% |
| @nozbe/microfuzz            |  45.76 ms |   29.93 ms |  78.66 ms |      434% |
| @nozbe/microfuzz (all opts) |  45.54 ms |   29.12 ms |  75.44 ms |      416% |
| fast-fuzzy                  | 388.07 ms |   76.94 ms | 464.28 ms |     2562% |
| fast-fuzzy (all opts)       | 356.86 ms |   79.10 ms | 451.41 ms |     2491% |
| Fuse.js                     |   7.01 ms |  195.34 ms | 202.50 ms |     1117% |
| Fuse.js (all opts)          |   7.02 ms |  180.91 ms | 188.10 ms |     1038% |
| fuzzy                       |   0.05 ms |   18.91 ms |  18.96 ms |      105% |
| fuzzy (all opts)            |   0.05 ms |   20.14 ms |  20.19 ms |      111% |
| fuzzysort                   |   0.04 ms |   69.62 ms |  69.66 ms |      384% |
| match-sorter                |   0.04 ms |   32.83 ms |  32.87 ms |      181% |
| uFuzzy                      |   6.01 ms |    3.03 ms |   9.29 ms |       51% |
| uFuzzy (all opts)           |  10.78 ms |    4.81 ms |  15.65 ms |       86% |
| _all libraries (geomean)_   |   2.51 ms |   31.03 ms |  54.46 ms |      301% |
<!-- bench:end -->

**The session batch** (one process: a warmup match, then the twenty probes once each):

<!-- bench:batch-ascii -->
| Library                     | batch/query | batch total | batch rel |
|-----------------------------|------------:|------------:|----------:|
| **Krino**                   |     3.88 ms |    83.25 ms |  **100%** |
| Krino (acronym)             |     4.06 ms |    87.30 ms |      105% |
| @nozbe/microfuzz            |    11.81 ms |   272.01 ms |      327% |
| @nozbe/microfuzz (all opts) |    12.03 ms |   268.20 ms |      322% |
| fast-fuzzy                  |    58.95 ms |  1250.94 ms |     1503% |
| fast-fuzzy (all opts)       |    58.70 ms |  1243.29 ms |     1493% |
| Fuse.js                     |   186.13 ms |  3848.22 ms |     4623% |
| Fuse.js (all opts)          |   172.60 ms |  3614.87 ms |     4342% |
| fuzzy                       |    18.39 ms |   389.53 ms |      468% |
| fuzzy (all opts)            |    19.63 ms |   414.80 ms |      498% |
| fuzzysort                   |     4.68 ms |   159.81 ms |      192% |
| match-sorter                |    25.89 ms |   557.99 ms |      670% |
| uFuzzy                      |     2.10 ms |    45.51 ms |       55% |
| uFuzzy (all opts)           |     3.46 ms |    73.38 ms |       88% |
| _all libraries (geomean)_   |    16.10 ms |   357.27 ms |      429% |
<!-- bench:end -->

### mixed corpus

<!-- bench:speed-mixed -->
| Library                     |    index | cold query |     total | total rel |
|-----------------------------|---------:|-----------:|----------:|----------:|
| **Krino**                   |  0.30 ms |   17.13 ms |  17.44 ms |  **100%** |
| Krino (acronym)             |  0.29 ms |   17.27 ms |  17.59 ms |      101% |
| @nozbe/microfuzz            | 53.95 ms |   32.33 ms |  82.75 ms |      474% |
| @nozbe/microfuzz (all opts) | 48.08 ms |   31.60 ms |  80.97 ms |      464% |
| Fuse.js (all opts)          |  7.06 ms |  182.80 ms | 189.97 ms |     1089% |
| fuzzysort                   |  0.05 ms |   76.82 ms |  76.87 ms |      441% |
| match-sorter                |  0.04 ms |   39.10 ms |  39.15 ms |      224% |
| uFuzzy (all opts)           | 11.60 ms |    5.09 ms |  16.73 ms |       96% |
| _all libraries (geomean)_   |  1.56 ms |   30.96 ms |  45.89 ms |      263% |
<!-- bench:end -->

**The session batch** (one process: a warmup match, then the twenty probes once each):

<!-- bench:batch-mixed -->
| Library                     | batch/query | batch total | batch rel |
|-----------------------------|------------:|------------:|----------:|
| **Krino**                   |     3.39 ms |    74.89 ms |  **100%** |
| Krino (acronym)             |     3.40 ms |    75.06 ms |      100% |
| @nozbe/microfuzz            |    13.20 ms |   295.96 ms |      395% |
| @nozbe/microfuzz (all opts) |    12.98 ms |   294.00 ms |      393% |
| Fuse.js (all opts)          |   169.97 ms |  3553.26 ms |     4744% |
| fuzzysort                   |     3.67 ms |   151.16 ms |      202% |
| match-sorter                |    29.07 ms |   625.58 ms |      835% |
| uFuzzy (all opts)           |     3.71 ms |    78.66 ms |      105% |
| _all libraries (geomean)_   |    10.36 ms |   244.87 ms |      327% |
<!-- bench:end -->

The acronym configuration runs strictly _more_ code per query (an extra tier, plus the one-edit rescues on candidates that reach it); its 100–105% cells are that price plus load swing.
Read sub-15% differences as statistical ties, the tie band from here on, and larger ones as real.
Folding uFuzzy sits just inside the tie band on this corpus: 3.39 ms for Krino to uFuzzy's 3.71 (109%).

Configurations that can't fold diacritics are omitted rather than flagged. A non-folding row on this corpus is timing a different, easier task (it silently misses accented matches), and we already _know_ it fails: on the accent-probe query `kepa` (from "Kępa…") at 10k, base uFuzzy finds _0_ matches where its folding (all opts) config finds 4 and Krino 8 ([`bench/hits.test.ts`](../bench/hits.test.ts)).
Omitted: uFuzzy and fuse.js base configs (their (all opts) rows fold and stay), and fast-fuzzy and fuzzy entirely; they have no folding option at all.

### Reading the speed numbers

Every cell is process-cold, so read the columns as three different workloads, not three qualities of one number.
The **batch** column is the honest headline: one process, twenty distinct queries, and the amortisation each design promises either shows up or doesn't.
Krino's batch is carried by its architecture — a staged reject path (a per-item union of char-class bitmasks, then a native regex gate) cuts 90–100% of items before any ladder work, and the lazy preparation is paid once, by the first typo-shaped query, for the whole session.
_uFuzzy wins the raw batch at 100k on ascii_ (55% of Krino bare, 88% folding) and its bare `batch/query` is the cheapest in the set; on mixed its folding configuration lands inside the tie band (105%), and its MRR (0.08–0.11 bare, 0.39–0.52 folding) is what the price buys.
Krino's batch beats everything else — ~4× its parent microfuzz, 2× fuzzysort, ~8× match-sorter, ~15× fast-fuzzy (ascii; it can't fold), ~47× Fuse.js on mixed — while topping both scorecards outright.
The **cold query** column is where Krino's laziness presents its bill: ~17 ms mean at 100k, most of it the rescue's union-and-bigram mask build, paid once per searcher and visible per probe kind in the 10k tables (typo probes pay it, literal probes pay the ~4 ms raw gate).
An eager-index engine inverts the shape: fast-fuzzy's first answer is cheap only because its constructor already spent ~360–390 ms.
The **index** column plus the first answer is the one-shot ledger, and there `fuzzy`'s bare substring scan is the only thing cheaper than Krino at any quality level.
Cross-_type_ speed isn't apples-to-apples: **typo-tolerant** libs (Fuse.js, fast-fuzzy) do far more work per query, and non-folding configurations are omitted from the mixed table entirely (they would be timing a different task).
**fast-fuzzy is corpus-sensitive**: its trie rewards shared-prefix data but this natural-language corpus prunes less, dropping it among the slowest (on a combinatorial word-grid it measured far better; corpus shape moves these numbers a lot).

## A frontend session: typing `grady` at 100k

Typing is a _sequence_: each query extends the last.
Krino's prefix-narrowing cache rescans only the previous query's mask-gate survivors, so successive keystrokes get cheaper; every other library pays a full scan per keystroke.
The probe types the doc's surname query `grady` from the 3-character UI gate onward (real UIs gate search behind 2–3 characters, because a 1–2 char query matches a huge fraction of the corpus and every rich-result library pays to materialize it).
Each step is timed at its correct cache state (the untimed reset replays the previous prefix before every sample), on the 100k mixed corpus.

<!-- bench:session -->
| Library            |  `gra` | `grad` | `grady` | session |
|--------------------|-------:|-------:|--------:|--------:|
| Krino              |   3.05 |   1.71 |    0.70 |    5.46 |
| @nozbe/microfuzz   |  43.43 |  35.83 |   36.04 |  115.30 |
| fuzzysort          |   7.82 |   4.75 |    3.05 |   15.62 |
| uFuzzy (all opts)  |   4.65 |   2.37 |    2.51 |    9.53 |
| Fuse.js (all opts) | 117.35 | 107.44 |  144.00 |  368.79 |
<!-- bench:end -->

Krino's per-keystroke cost falls _over 4×_ across the word (3.05 → 1.71 → 0.70) as the survivor cache narrows: the 3-character query is the widest candidate set the session ever sees, and it is the one that pays.
Krino takes every step of the session, the wide opener included (3.05 vs uFuzzy's 4.65), and the session total by 1.7× (5.46 vs 9.53) — while returning tiers and ranges against uFuzzy's bare index array, at 0.52 MRR to Krino's 0.84.
microfuzz stays flat at ~36–43 ms: same subsequence approach with no survivor cache, so nothing narrows between keystrokes.
Unlike the scorecard, this table is a single process rather than a median of five, so read its cells with the tie band in mind.
All rows assume a warm process: one-time costs (Krino's mask build, fuzzysort's lazy target prep) are paid at load, not on keystroke one; the cold cells above price them.
Measured by [`bench/session.test.ts`](../bench/session.test.ts).

## Matching inside long text

Everything above matches short labels in a list; the other workload is one large string: `fuzzyMatch` over a document.
The hazard there is the fuzzy tier assembling a "match" from characters scattered across unrelated words, so the tier rejects any assembly covering less than 18% of the span it stretches across (`DENSITY_FLOOR` in [`src/fuzzy.ts`](../src/fuzzy.ts)).
The constant comes out of a measurement: with the floor disabled, this probe collects 570 junk chains across both corpora at every length, maxing out at _0.143_ density, while the sparsest genuine match (initials scattered across a four-word name) measures _0.211_; 0.18 splits the gap with margin both ways.

The probe: the document is the mixed corpus joined with spaces and sliced to graded lengths; queries are 40 real corpus words verified absent from the largest slice (no substring anywhere), so any hit is the fuzzy tier assembling a junk chain.

<!-- bench:longtext -->
| doc chars | junk rate | present hits | miss ms |
|----------:|----------:|-------------:|--------:|
|        64 |        0% |          8/8 |   0.006 |
|       128 |        0% |        15/15 |   0.007 |
|       256 |        0% |        20/20 |   0.008 |
|       512 |        0% |        20/20 |   0.010 |
|      1024 |        0% |        20/20 |   0.026 |
|      2048 |        0% |        20/20 |   0.044 |
|      4096 |        0% |        20/20 |   0.080 |
|      8192 |        0% |        20/20 |   0.147 |
|     16384 |        0% |        20/20 |   0.288 |
<!-- bench:end -->

Zero junk at every length, while every genuinely present word still matches (a present word is a substring, so `contains` needs no fuzzy assembly) and label-corpus behaviour is unchanged (same MRR, same ranks, slightly tighter sets: `rsaw` 8 → 7, ascii's `sgh` 55 → 31).
Miss cost includes the one-edit rescues (a miss must fail those too), which is what a document-length miss pays for the typo rescues on labels; it stays under a third of a millisecond at 16k chars.
Residual exposure is the adjacent-word assembly (`zebra` over "zero … branch", density 0.38), structurally identical to wanted word-start matches like `hewo` → "hello world" (0.5), so no floor separates them; they need adjacency by luck, and they rank last when they occur.
Literal-only matching, for callers that want no fuzzy assemblies at all, is a one-line `tier` filter.
[`bench/longtext.test.ts`](../bench/longtext.test.ts) keeps this table as a regression guard, asserting the junk rate is exactly zero at every length.

## The recommendation

Everything above condenses to one recommendation: _pick Krino for list matching_, with two carve-outs the data supports.
Three things carry the claim, each measured in its own section:

- **Quality**: Krino (acronym) tops the scorecard on both corpora outright (0.87 mixed / 0.82 ascii), with the smallest result sets of the subsequence engines (median 7 rows on structured queries where Fuse.js ships ~90); the phrase-typo probes are what pushed the lead past the tie band.
- **Cost, measured cold**: the cheapest twenty-query session of anything above 0.5 MRR at both sizes (batch 18.7 ms at mixed 10k, ~0.8 ms per query after the first; ~4–47× under every typo-tolerant or tiered alternative), a near-zero constructor, ~5.5 kB gzip, zero deps. The honest asterisk is the first call: Krino's lazy preparation lands its whole bill on query one (~4.4 ms at 10k, ~17 ms at 100k), and a workload that only ever asks one question of one searcher should read the one-shot ledger, where bare `fuzzy` is cheaper.
- **Long text**: the density floor holds `fuzzyMatch` junk at 0% at every measured document length — phrase probes included — so the same engine covers documents, not just labels.

The carve-outs:

- **Typo tolerance beyond a single edit.** The one-edit tiers rescue every single-character typo (transposition, insertion, deletion and substitution) at rank 1 with a single row — inside phrases too, where the failing word is corrected alone — but _two or more_ edits in one query still need real edit distance, and Krino deliberately refuses both deep scatter ("the fuzzy limit") and the double-typo phrase.
  If user-typed queries over messy data must match through those, Fuse.js (Bitap) or fast-fuzzy (edit distance) is the right tool; the scorecard prices what that buys and costs: 0.81/0.59 MRR on mixed, ~18–24 ms per cold query, ~90–450-row result sets.
- **Raw throughput when a bare index array is enough.** uFuzzy wins the 100k ascii batch outright (55% of Krino bare, 88% with folding; on mixed its folding config only ties) and owns the cheapest bare per-query and miss cells at every size.
  It costs most of the match quality to get there — 0.08–0.11 MRR bare, 0.39–0.52 folded, against Krino's 0.79–0.87 — and no ranges, tiers, or per-field config. A real trade, priced in full above.

The rest of the field is dominated on these benchmarks:

- **@nozbe/microfuzz**: Krino's parent; same subsequence approach, ~4× the batch at 100k, 2–17× larger result sets, no tier output. Its 0.46 mixed MRR sits 38 points under base Krino: it returns nothing at all on the insertion, substitution and phrase-typo probes.
- **fuzzysort**: the cheapest per-query cost after uFuzzy, but its prepare-all pass lands a ~7 ms first call (77 ms at 100k) that stock usage pays inside the first `go()`, and prefix-biased ranking sinks plain-word and infix ranks (20th on `ergonomic`, 13th on `gonom`).
- **match-sorter**: tiered ranking but no ranges and no multi-word; never places best on any probe, 0.29–0.32 MRR at mid-pack speed.
- **fuzzy**: substring-only and order-sensitive; 0 matches on the reversed phrase, no folding, no ranges.
- **fast-fuzzy**: the heaviest build (~390 ms at 100k) and slowest queries on these corpora; its trie rewards shared-prefix data, which natural-language corpora don't provide.

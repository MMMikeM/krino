# Optimisation: where the time goes, and what moved it

Companion to [measurement.md](./measurement.md), which covers how the benchmark harness came to be wrong and how it was fixed.
This one covers what the corrected harness then found.

Everything here is measured on the ascii and mixed corpora at 100k, one library per process.
Every change listed as landed produced **identical ranks and MRR** across all thirty probes — these are optimisations, so any output change is a bug, not a trade.

## Where the time actually goes

Counted per query on the ascii corpus at 100k:

```
100,000 items
   ↓ mask scan            0.16 ms   3%    94% rejected
 ~6,208 mask survivors
   ↓ front gate           ~0.2 ms   5%
   ~741 reach the ladder
   ↓ tier ladder          ~4.2 ms  92%    ~5.7 µs per candidate
   390 results
```

The shape that matters: **the pre-filter was never the problem.**
Krino's entire gate — a per-item `Int32Array` mask read plus a native regex on survivors — costs less than uFuzzy's _whole_ query, which has no index at all.
Everything expensive happens per surviving candidate, and only 53% of candidates that reach the ladder produce a result.

## What landed

| change              |                  ascii |                  mixed | what it does                                               |
| ------------------- | ---------------------: | ---------------------: | ---------------------------------------------------------- |
| Anchored front gate |             −12% query |              −8% query | Gate at a placement the chunk assembler would actually try |
| Rescue budget       |           −10.5% query |            −9.2% query | Stop attempting corrections once ten literal hits exist    |
| Lazy fields         | −34% query, −69% build | −54% query, −61% build | Materialise a field's text only when its mask survives     |

### Anchored front gate

`buildFuzzyGate` was a bare subsequence test, so it admitted any field whose characters appeared in order, and the ladder then rejected 64% of them.
`fuzzyChainMatch` only ever begins a chain where `admitsChunk` holds — the placement opens a word, or runs the query's first three characters consecutively — and every earlier tier satisfies one of those anyway.
Requiring the anchor cut fields reaching the ladder by 32% (ascii) and 39% (mixed) and cannot false-reject.

It is also monotone under query extension, which the survivor cache depends on: extending a query lengthens the subsequence and never changes its first three characters, so both branches only ever admit fewer fields.

### Rescue budget

`TYPO_PENALTY` is 2.1, so the best possible correction scores 2.1 — strictly worse than any `exact`, `prefix`, `boundary` or `contains` match, all of which score at or below `SCORES.CONTAINS` (2).
Once ten literal-tier hits exist, no correction can enter the top ten, so computing them is work no caller can observe through the ranking.

Before the budget, the rescue ran 17,616 times per query to produce about five corrected results — roughly 3,500 attempts per correction.

The load-bearing detail is counting _literal-tier_ hits rather than all results: `fuzzy` starts at CONTAINS and rises past 2.1, so fuzzy hits must not be allowed to crowd out a correction.

### Lazy fields

The largest single win, and the one that reframed the rest.

The mask rejects ~94% of a corpus, yet the index was building a trimmed copy, a normalised copy and a `PreparedField` object for **every** item — so ~94% of 27 MB and ~40 ms of build was constructed for items no query reads.

Now the build loop produces masks and nothing else, folding characters straight out of the raw string with no allocation, and a field's text is materialised on first mask survival and cached.
The first query materialises ~5,400 fields; the second materialises none.

This went through three passes, each removing work that did not need to be in the loop:

| build, ascii 100k                                    |             |
| ---------------------------------------------------- | ----------: |
| eager                                                |     39.5 ms |
| don't _retain_ the strings                           |     18.9 ms |
| don't _compute_ them either — fold the mask from raw | **7.25 ms** |

The second pass still normalised every item and allocated 100k objects before discarding them.
The third replaced `for (const ch of raw)` — which allocates a one-character string per code point, about 3M over a 100k corpus — with a `charCodeAt` loop that only folds for code points above 127.

Deferred work has to land somewhere, and it lands on the first query: cold is flat on ascii and ~6% worse on mixed.
The one-shot total, build plus first query, is 3.1× better on ascii and 3.7× on mixed.

## What was rejected

The negative results are the more useful half, because each was a confident hypothesis that measurement killed in minutes.

| hypothesis                                      | verdict                                                                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bigram presence mask**                        | Slower queries **and** +38% build. Four integer ANDs per variant plus a closure lost to _one_ call into V8's Irregexp, which is compiled machine code with fast literal-alternation dispatch. |
| **Flattening the index into a string arena**    | The scan it would optimise is 3.4% of query time. The `Int32Array` mask scan was already doing its job.                                                                                       |
| **Interleaving query samples across libraries** | Inflated fuzzysort 0.178 → 0.646 ms and uFuzzy 0.183 → 0.453 by making every sample run cache-cold. Correct for 1–40 ms index builds, wrong for sub-millisecond queries.                      |
| **Larger V8 semi-space**                        | krino held at 4.78 / 5.16 / 4.96 / 5.17 ms across default/16/64/128 MB. Young-generation sizing was not the variance.                                                                         |
| **`limit` option**                              | The sort is ~3.4k comparisons on 392 results — under 0.1 ms. A UX feature, not a speed lever.                                                                                                 |
| **Lazy ranges**                                 | 1.08–1.67 range entries per result, and the fuzzy tier's ranges fall out of the chain walk that produces the score. Nothing to defer.                                                         |
| **`missingClasses` dispatch**                   | Sound and free, but its effect sits below the harness's ±3% noise floor, so it cannot be claimed.                                                                                             |

Two patterns run through the rejections.

**Every bet against a native regex lost.** The anchored gate won because it makes Irregexp reject _earlier_; the bigram mask lost because it tried to replace Irregexp with a JS loop.

**Every win came from moving work off the 100,000 path**, onto the ~6,200 or ~741 paths. Every rejected idea added per-item work to speed up a path that was already cheap.

## Allocation is the hidden axis

Churn per query, measured at ascii 100k:

| library           | allocated/query | results/query |
| ----------------- | --------------: | ------------: |
| uFuzzy (all opts) |          4.5 kB |           144 |
| uFuzzy            |          6.3 kB |           115 |
| Krino             |         33.3 kB |           392 |
| @nozbe/microfuzz  |         62.1 kB |           832 |
| fuzzysort         |         95.0 kB |           832 |
| Krino (acronym)   |         98.9 kB |           392 |

Churn tracks measurement variance almost exactly: uFuzzy at 4–6 kB is stable to ±5%, Krino at 33 kB swings ±20%, fuzzysort at 95 kB spreads 122–170%.
That is why Krino was the library the old shared-process harness distorted most.

`Krino (acronym)` allocating 3× base for **identical** output is an unexplored defect: same 392 results, three times the garbage.

## Open

- ~~`rawCharMask` has no soundness test~~ — done: `test/raw-mask.test.ts` and `bench/raw-mask.test.ts` pin that the (now fused) `rawFieldScan` mask never drops a bit over either corpus.
- ~~`fieldMasks` duplicates `unionMasks` for one-field lists~~ — done: `buildUnionIndex` shares the array when `specCount === 1`.
- The acronym configuration's 3× allocation: `acronymTier` builds an offsets array and initials string per surviving field, hit or miss. Speed parity with base holds in every published cell, so this is GC pressure only; fix by streaming over module scratch if a heap number ever moves on it.
- ~~Build-time flags in `src/flags.ts`~~ — done: the missing-class dispatch is unconditional (a variant needing a class the field lacks always fails the containment test it skips, so the short-circuit is result-neutral), and `src/flags.ts` plus the `bench/variants.ts` machinery are deleted.

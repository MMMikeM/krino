# Performance design rationale

Why Krino is fast the way it is: the standing design decisions, the evidence that settled them, the alternatives rejected along the way, and the hazards any future change must respect.
Current numbers live in [benchmarks.md](./benchmarks.md) and regenerate with `pnpm bench`; the sequence of changes lives in [CHANGELOG.md](../CHANGELOG.md) and git history.
The numbers quoted here are decision evidence: each comes from the run that settled its decision, the relative shape is the claim, and none of it is regenerated.

## No corpus index

The question that started this document: should `createFuzzySearch` index its corpus?
The answer is no, and the reasoning is worth keeping because the pressure to index recurs whenever a trie-based library benchmarks well.

### Why fast-fuzzy looked fast

On an early combinatorial corpus (`ADJ × NOUN × SUFFIX`), fast-fuzzy benchmarked ~4× faster than Krino while doing typo-tolerant edit-distance matching.
The trick is structural, not algorithmic: it inserts every candidate into a trie, walks it with a threshold-pruned DFS, and extends two DP rows along trie edges, so shared prefixes are stored and scored once and most candidates are never scored at all.
That speed is entirely corpus-dependent, because the pruning only skips subtrees when candidates share prefixes.
On seeded natural-language faker data (product, company, person and place names) the same library fell to among the slowest in the set.
"Typo-tolerant" says nothing about speed; the data structure and the corpus do.

### Why a prefix trie fits Krino badly

A trie accelerates prefix and exact lookups, which are already Krino's cheapest tiers (`startsWith`, `===`).
The expensive tiers match mid-string and out of order: `boundary` and `contains` sit anywhere in the field, `multi-word` accepts any word order, and `fuzzy` is a subsequence chain scattered across the field.
A prefix trie helps none of them.
Worse, threshold pruning needs a single scalar cutoff, and Krino has none: the tier ladder returns every item that matches at any tier, ranked, so there is no "score below X, skip it" to prune on.

### What an index would have to be

If scale far beyond the target were ever a goal, the right structures are an inverted token index (turns the multi-word and boundary tiers into posting-list intersections), a trigram index (gates the fuzzy and contains tiers without visiting every item), or a suffix automaton for arbitrary-substring search (powerful but likely overkill).
They stay unbuilt for four reasons:

- **Bundle size.** Krino is ~5.5 kB gzip; a real index could double that, directly against the "tiny" pitch.
- **The API model.** `fuzzyMatch` must stay stateless; that is the point of the primitive-first design, so any index is confined to `createFuzzySearch`.
- **Build and memory.** Index construction and posting-list storage grow with the corpus, and only pay off when N is large.
- **Scope.** The scan-level design below carries the target use (command palettes, pickers, autocomplete over lists you already hold) and the published sizes without any of it; [benchmarks.md](./benchmarks.md) holds the standings.

Revisit only if Krino deliberately expands to corpora well past 100k.

## The scan architecture

The searcher is one honest O(N) scan behind a stack of rejections, and the stack is governed by a single invariant.

### Gates may only false-pass

Every pre-filter (the bitmask, the regex gates, the bigram gate, the survivor cache) exists to skip work.
A gate that rejects a field some tier would have matched is a correctness bug, not a tuning question.
`bench/funnel.test.ts` asserts the property per bench query, and `bench/searcher-parity.test.ts` asserts the searcher returns exactly what per-item `fuzzyMatch` accepts.

### Reject with an integer, then a regex, then the ladder

Stage 0 is a 32-bit character-class mask per item (`charMask`); one integer AND rejects an item before any regex runs.
Bucketed classes (digits, non-ASCII) can only merge bits, so a collision weakens the filter, never inverts it.
Stage 1 is one native regex chosen by query type.
Multi-word queries get an order-independent presence gate, because the multi-word tier matches words in any order and a subsequence gate would falsely reject `"foo bar"` against `"bar … foo"` (pinned by `bench/correctness.test.ts`).
Single-word queries get a subsequence gate: with one word there is no ordering concern, and one in-order pass is both stricter and cheaper than the presence gate's k lookaheads.
For pure a–z queries the mask is already an exact distinct-character presence check, so the presence regex is skipped as redundant (`presenceGateRedundant`).

The substitution rescue needs the mask relaxed by one character class, and that relaxation is the expensive move: it widens the survivor set the whole speed story depends on rejecting.
A bigram gate re-tightens it using two facts that pin the edit down: a field missing exactly one class is only reachable by an edit at the query's sole character of that class, and every rescue-eligible tier is a contiguous occurrence, so every query bigram away from that position must appear in the field.
Bigram hashes collide by merging bits: false-pass again.

### Preparation is lazy

`createFuzzySearch` only allocates; a field is trimmed, normalised and masked the first time it survives a gate (`materialise` in `src/search.ts`), so the caches warm to the working set rather than the corpus.
Single-word gating runs on the caller's raw strings (`buildRawGate`), and `bench/raw-mask.test.ts` sweeps both bench corpora to pin that the raw scan never drops a mask bit against the eager equivalent.
The one structure that costs a whole-corpus pass (the rescue's union masks and bigram sets) is built by the first query that reaches the relaxed scan; a session whose queries all match literally never pays it.
The cost lands where a user pays it: construction is allocation, the first rescue-shaped query carries the deferred pass, and the process-cold model in benchmarks.md measures exactly that split.

### Survivors carry across keystrokes

When a query extends the previous one (the typing case), only the previous survivors are rescanned.
This is sound only because the cache stores a gate-pass set: gates are monotone under query extension, since extending a query only adds requirements, while the match set is not (`"the quick brown fox"` matches `fox brown` via the multi-word tier and fails `fox brow`), so caching matches would be wrong.
Backspace and replacement queries fall back to a full scan, and the relaxed rescue set is not a gate-pass set, so it never seeds the cache.
`bench/session.test.ts` measures the effect keystroke by keystroke, each at its correct cache state.

### Corrections are budgeted

Every correction scores at least `TYPO_PENALTY` (2.1), above `SCORES.CONTAINS` (2), so once ten literal hits sit at or below `CONTAINS` no correction can reach a top-ten page.
The rescue is then skipped as provably invisible work.

### Word membership scans instead of hashing

`wholeWordOccurrence` finds a boundary-bounded occurrence with an `indexOf` walk, yielding membership and position in one pass, with no per-field `Set` living on the heap.
The stated trade: for document-length fields (`strategy: "off"` body text) membership is O(field length) per query word where a Set was O(1).
It is bounded in practice (the mask rejects most items first, the scan stops at the first absent word, and the tier only runs for multi-word queries that missed every earlier tier) and unmeasured by the short-string bench corpora.
Revisit trigger: a long-field corpus probe showing the multi-word tier dominating query time; the fix is an opt-in per-field word index for long fields, not a return of the always-on Set.

## Decision evidence

The tables here justify constants and behaviour that look arbitrary in the source.
Each is quoted from the run that settled the decision; harnesses have changed since, so read relative shape, not current standings.

### Bounded chunk-start retries

`MAX_CHUNK_STARTS = 4` in `src/fuzzy.ts` is a correctness bound, not a speed knob.
Leftmost-greedy placement stranded chains whose first character also opens an earlier word: 307 missed assemblies and 131 suboptimal ones over the ascii corpus at chain level.
Retrying the first chunk from other admissible placements fixes that, but retrying from every placement broke the long-text guard, taking the junk rate from 0 to 45% at 16k characters.
The finding worth keeping: the density floor is not scale-free.
It is a ratio, so a compact junk assembly clears it at any field length; what actually kept junk out of long text was the single greedy attempt stretching junk chains into sparse spans.
Junk matching is a multiple-comparisons problem: every additional assembly attempted is another draw at a dense coincidence, so an unbounded search leaks more as fields grow.

| first-chunk attempts | missed | suboptimal | long-text junk hits |
| -------------------- | ------ | ---------- | ------------------- |
| 1 (previous)         | 307    | 131        | 0                   |
| 3                    | 0      | 31         | 0                   |
| **4**                | **0**  | **30**     | **0**               |
| 8                    | 0      | 30         | 4                   |
| ∞                    | 0      | 30         | 43                  |

Four attempts buy everything an unbounded search does while staying clear of the leak; the residual 30 need full backtracking, which is exponential and is the thing that leaks.
The implication for any future fuzziness work: widening what reaches the chain reopens the hazard, and the density floor will not catch it alone.
Re-run `bench/longtext.test.ts`, not just the unit tests.

### Corrections price above `CONTAINS`

Rank, not recall, is the metric: match-set size barely matters next to where the queried item lands.
MRR of the intended item over the ascii corpus, before and after the one-edit rescues:

| probe         | before | after | note                           |
| ------------- | ------ | ----- | ------------------------------ |
| clean         | 1.000  | 1.000 |                                |
| prefix        | 0.977  | 0.977 |                                |
| infix         | 0.973  | 0.973 |                                |
| deletion      | 0.968  | 0.962 | was already matching, as fuzzy |
| insertion     | 0.004  | 0.998 |                                |
| transposition | 1.000  | 1.000 |                                |
| substitution  | 0.000  | 0.996 |                                |

The first version priced corrections at the inherited 0.9 penalty, above literal matches, and infix sank to 0.906: other items' guesses displacing the item the user's text literally appears in.
Raising the penalty past `CONTAINS` fixed it with no loss anywhere.
A correction must never outrank a literal hit; `test/tier-constants.test.ts` pins the constants.

### Typo thresholds scale with the field

A constant minimum query length for the rescues has to pick one workload to fail: at a floor of 7 the long-text junk rate was 0 but short queries lost their insertion and substitution ranking (MRR 0.547 and 0.000); at 5 the ranking held (0.952 and 0.923) but long text junked 30 probes.
`minTypoQueryLength(fieldLength)` gets both, and it is the same lesson as the retry cap: junk risk grows with the field, so the guard has to grow with it.

## Benchmarking lessons

The live methodology is documented in [benchmarks.md](./benchmarks.md); these are the lessons that shaped it and constrain any future harness.

- **Corpus shape drives the table.** The fast-fuzzy flip above is the proof: fastest-ish on a shared-prefix word grid, among the slowest on natural-language data. State the corpus, and prefer natural-language data unless prefix-clustering is what you mean to measure.
- **Verify the matching, then time it.** A speed table over unverified matchers compares different jobs. `bench/hits.test.ts` records every library's match count and the queried item's rank per query; it caught uFuzzy silently returning nothing on accent-stripped queries without `latinize`.
- **Design the corpus property you mean to test.** The en faker generators measured 0% diacritics (faker's French company names too), so diacritic density had to be constructed, not assumed.
- **Amortisation is a claim, not a given.** Lazy and cached designs move cost rather than remove it; only process-cold measurement (fresh process per sample, benchmarks.md "One measurement model") shows who actually pays and when.

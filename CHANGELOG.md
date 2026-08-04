# Changelog

## 1.0.0 (unreleased)

Initial release — nothing has been published before this; earlier version numbers in git history were internal development stages.

Ekrina is a zero-dependency fuzzy matcher: a rich single-string primitive (`fuzzyMatch`) returning `{ score, tier, ranges }`, and a thin cached collection search (`createFuzzySearch`) built on it.
Scoring is lower = better, and `score <= SCORES.CONTAINS` is exactly "the query text appears here" — everything above it is a fuzzy chain or a one-edit typo rescue, told apart by `tier`.

Design decisions worth recording, with the measurements that made them:

- **Typo corrections sort below every literal tier.**
  `TYPO_PENALTY` (2.1, exported) is added to the corrected query's tier, so even a corrected exact hit (2.1) sits under a true `contains` (2).
  A correction is a guess about what the user meant; a substring match is something they actually typed.
  Priced at 0.9 the guess won, and it was measurable — infix queries lost the intended item from MRR 0.973 to 0.906 as other items' corrections displaced it.
- **One `corrected` tier for every one-character edit** — swap ("geenric"), insertion ("generric"), deletion ("genric"), substitution ("genaric") — with `MatchResult.corrected` carrying the fixed query in the caller's casing.
  Which edit fired is derivable by diffing and nothing actionable branches on it.
  MRR of the intended item over the ascii corpus: insertion 0.004 → 0.998, substitution 0.000 → 0.996; deletion 0.968 via the fuzzy tier before the rescue existed, 0.962 ranked as a typo under the penalty.
- **Phrase rescues correct exactly one word.**
  A multi-word query with one absent word rescues that word alone and rescores the whole phrase; the literally-occurring words pin the candidate fields first, so enumeration runs over a handful of fields rather than the corpus.
  Two mistyped words stay unmatched by design — refusal beats guessing — and `bench/longtext.test.ts` asserts a mistyped word beside a real one never invents a phrase match at any document length.
- **A density floor instead of a strategy knob.**
  The fuzzy tier rejects any chunk assembly covering less than 18% of its span (measured junk chains ≤ 0.143 density, sparsest genuine match 0.211).
  Junk rate over document-length text: 5–98% across measured lengths → 0%, with label behaviour unchanged.
  Literal-only filtering stays a one-liner: drop results with `score > SCORES.CONTAINS`.
- **Gates may only false-pass.**
  The subsequence pre-gate anchors where the chunk assembler would actually start, cutting fields that reach the ladder by 32% (ascii) and 39% (mixed) with byte-identical result sets; `bench/funnel.test.ts` asserts the false-pass-only property per field.
- **A bigram gate on the rescue's relaxed scan.**
  A field missing exactly one of the query's character classes is only reachable by an edit at that class's sole query position, so every query bigram away from that position must be present in the field.
  Relaxed-scan admissions drop from 19.3% of a 100k corpus to 5.2% (ascii) and 16.7% to 3.2% (mixed), with result sets, ranks and MRR byte-identical (`bench/searcher-parity.test.ts`).
- **The rescue stops once ten literal hits exist.**
  No correction (≥ 2.1) can reach a top ten already filled at or below `SCORES.CONTAINS` (2), so the rescue becomes provably invisible work and is skipped.
- **The fuzzy tier retries its first chunk from up to four admissible placements** and keeps the cheapest assembly, so a query whose first character also opens an earlier word ("towls" hitting the T of "Tasty Silk Towels") is not stranded: 307 → 0 missed assemblies over the ascii bench corpus.
  Later chunks stay leftmost-greedy — reconsidering those is what starts leaking junk.
- **The searcher prepares nothing up front and rescans survivors while you type.**
  Construction only allocates (~1 ms for a 100k list); a field is normalised and masked the first time it survives a gate, and the one whole-corpus pass (the rescue's union-and-bigram masks) waits for the first query that needs the relaxed scan, so literal-only sessions never pay it.
  A query extending the previous one rescans only the previous gate survivors, sound because every gate is monotone under query extension; typing `gra` → `grad` → `grady` over 100k items runs 3.0 → 1.7 → 0.7 ms per keystroke (docs/benchmarks.md, session table).

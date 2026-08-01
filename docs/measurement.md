# Measurement: the trap, and what it taught us

This document exists because the speed benchmark spent a long time confidently publishing numbers that were wrong, and because the way we misdiagnosed it was more instructive than the bug.
It is written for whoever next changes `bench/`, so they do not repeat it.

## The symptom

The publish ritual kept tripping its own contamination guard.
That guard asserts a physical invariant: `krino (acronym)` runs strictly more code per query than base `krino`, so base measuring slower means the run absorbed GC or thermal debt.
It fired repeatedly, sometimes fatally, and the numbers behind it were incoherent — base and acronym would sit 38% apart in one run and 0.5% apart in the next, in either direction.

Individual cells looked like this at 100k:

| cell             | samples |   median | spread (max/min) |   rme |
| ---------------- | ------: | -------: | ---------------: | ----: |
| ascii 10k krino  |      20 | 0.293 ms |             214% | 21.4% |
| ascii 100k krino |      12 | 3.912 ms |            46.8% |  9.5% |
| mixed 10k krino  |      20 | 0.307 ms |             115% |  8.4% |

A cell whose own samples span 214% cannot support a claim about a 15% difference between two cells.
That was true of every published speed number, and nothing in the artifact recorded it, because the stored cell was `{ ms, sd }` and the docs printed `ms`.

## The cause

`compare.bench.ts` built its searchers in a **top-level** loop over corpora and sizes.
Every `describe` callback closed over its configuration set, so all four corpus×size sets were constructed at module load and pinned for the entire run.

Measured with `bench/memory.ts`, one 100k configuration set retains ~593 MB — fast-fuzzy's trie alone is ~195 MB, and it appears twice as base and `(all opts)`.
Two 100k groups plus two 10k groups is roughly **1.3 GB, against a V8 heap limit of 2.25 GB on this machine**.

At that occupancy V8 never leaves incremental marking, and `setup: collectDebt` — a `gc()` before every task — becomes a full major collection over 1.3 GB.
Marking work then lands inside the timed windows.
The same pressure produced an outright `Worker exited unexpectedly` crash earlier in the same session, which was written off as a flake.

Four smaller faults compounded it, each individually survivable:

- **`warmupIterations: 1`**, plus one calibration probe, is two executions before timing.
  V8 has not tiered up by then, so early samples measure unoptimised code.
  Raising warmup from 2 to 20 moves krino's ascii 10k median from 0.303 ms to 0.259 ms — the published number was inflated by unoptimised code, not by the algorithm.
- **`gc()` inside the sampling loop.**
  Collecting before each timed region means every sample starts from a fresh heap and pays the allocation and marking that follows.
- **`mean` as the published estimator**, over as few as five samples.
  Timing noise is one-sided, so a mean averages in exactly the spikes a median rejects — an argument `hits.test.ts` already makes in a comment, for its own cells, while the speed path did the opposite.
- **`calibrated()` sizes the sample count from a single cold probe call**, so the same cell drew 5, 12, 13, 16, 17, 19 or 20 samples depending on how cold that one call happened to be.

## The misdiagnosis

The bug was in the harness the whole time.
Every intermediate explanation was wrong, and each was plausible enough to act on:

1. **"The run absorbed GC debt, rerun it."** — Reran twice. Same inversion, same direction. Persistence should have ruled out chance immediately.
2. **"The guard should escalate to fatal on magnitude."** — Wrong and dangerous. A paired measurement showed base and acronym sit within ±8% with the sign flipping between runs, because the acronym tier almost never fires on these corpora. The guard compares two configurations that are measurably identical; making it stricter would have blocked every future run on noise.
3. **"Interleave the query timing across configurations."** — Actively harmful. The index cells are interleaved for good reason and reusing the helper looked obvious, but consecutive samples then hit different libraries and every one runs cache-cold: fuzzysort inflated 0.178 → 0.646 ms and uFuzzy 0.183 → 0.453 ms. That does not add noise, it reorders the table. A 1–40 ms index build swamps cache warm-up; a 0.18 ms query is dominated by it.
4. **"The machine is contended by other processes."** — It was not. Load was decay from our own runs, with nothing above 3% CPU.
5. **"Keep all libraries in one process so comparisons stay paired."** — Backwards. Inside a group the libraries are not paired in any useful sense; they run sequentially in separate windows, each one's measurement degraded by its neighbours' heap, caches and inline caches.

## What actually found it

Running the same cell two ways, minutes apart on the same machine:

| ascii 10k    | full matrix | scoped to one group |
| ------------ | ----------: | ------------------: |
| krino spread |        214% |               28.5% |
| krino rme    |       21.4% |            **3.0%** |
| acronym rme  |       12.3% |            **2.7%** |

Seven times better from isolation alone, and the scoped numbers were physically sensible for the first time: krino 0.281 ms against acronym 0.315 ms, acronym slower by 12%, which is the direction the guard exists to assert.

Isolating further, to one library per process, drops resident memory from ~1.3 GB to 87–98 MB.
Cross-process reproducibility over five independent processes is then ±1–2% for the well-behaved libraries — far tighter than the 21% _within_ a single cell of the shared run.

## The deeper mistake

Having found the mechanical bug, the next instinct was to chase the cleanest possible number: run solo, warm up twenty iterations, take the minimum.
That is an asymptote no user ever reaches.

Measured cold, in a fresh process, with nothing warmed (ascii 10k):

| library          |   build | cold first query |     warm | cold / warm |
| ---------------- | ------: | ---------------: | -------: | ----------: |
| krino            |  3.7 ms |          3.25 ms | 0.249 ms |     **13×** |
| uFuzzy           |  5.2 ms |          2.12 ms | 0.220 ms |         10× |
| fuzzysort        |  0.1 ms |     **18.43 ms** | 0.212 ms |     **87×** |
| @nozbe/microfuzz | 12.2 ms |          3.15 ms | 1.145 ms |        2.8× |
| Fuse.js          |  2.9 ms |         23.14 ms | 18.01 ms |        1.3× |

The first query costs 9–87× the steady-state number the tables published, and it **reorders the field**.
On steady state fuzzysort, uFuzzy and krino are within 18% of each other.
Cold, uFuzzy leads at 2.1 ms, krino follows at 3.3, and fuzzysort is last by six times at 18.4, because its lazy prepare-all fires inside the first `go()`.
A reader choosing on the steady-state table alone would be misled about the experience their users actually have.

## What we now hold to

- **One library, one process.**
  A shared process shares its pathologies: heap pressure, garbage collection, cache residency and inline-cache shape all leak between libraries that are supposed to be measured independently.
  Cells run sequentially, never in parallel — concurrency reintroduces exactly the contention isolation removes.
- **A cold measurement is only possible in a process that has not run that library before.**
  This is the argument for isolation that has nothing to do with noise. By the seventh configuration in a shared process, "cold" is unmeasurable.
- **Publish both cold and warm.**
  They answer different questions — the first keystroke and the one-shot backend versus the second keystroke and the long-lived server — and they disagree by an order of magnitude.
- **Record the error bar, always.**
  A cell now carries its median, min, max, mean, sd, p75, p99, relative margin of error and sample count. Without the spread there is no way to tell a result from noise, and for two years there was none.
- **Keep `min` next to the median rather than choosing.**
  Their gap is a signal, not redundancy: fuzzysort's min is stable at ~0.205 ms while its median runs 0.23–0.25 ms with 122–170% spread, because its process-wide `prepare()` cache triggers collections mid-query. Publishing only the min would launder a real property of its design.
- **When a guard false-fires, fix the measurement, not the threshold.**
  The contamination guard was right to complain and wrong about why. Loosening it would have silenced the one thing pointing at a genuine defect.
- **Warm up properly, and collect once, outside the sampling loop.**
  Two iterations is not warm. A collection between every sample is not neutral.

## Where this leaves older numbers

Every speed cell measured by a full-matrix run predates this understanding and carries unknown error bars.
The quality results are unaffected: `hits.test.ts` builds one corpus at 10k per test and its ranks and MRR are deterministic, which is why they reproduced exactly across runs while the timings did not.

## The calibration blind spot, and the move to processes

The vitest-bench era ended on a simple observation: its calibration probe ran every query once, untimed, to size the sample loop — and that untimed pass silently paid every lazy first-call cost in the suite.
Krino's 18.5 ms mask build at 100k, fuzzysort's prepare-all, microfuzz's first-search slice: none of them could ever reach a timed sample, so the "total" column published index + one warm query as if it were a cold start.
Worse, the warm loops themselves sampled hundreds of repeats of a single query, tiering the JIT far past anything a real session reaches; nobody repeats one query three hundred times.

The replacement (bench/run.ts) measures nothing but first calls: a fresh node process per sample, constructor and first answer timed in consecutive windows, and one batch test per corpus — twenty distinct probes through one process — as the only warm-ish number, its warmth earned the way real sessions earn it.
Five to ten processes per cell suffice because every number under this model is milliseconds-scale; the hundreds-of-samples machinery existed only to resolve steady-state microseconds that no user ever observes.
Honesty guards moved with it: result counts asserted identical across a cell's processes, variant order rotated per repetition, the krino-vs-acronym physical invariant now fatal to the run, and a drift canary bracketing the whole matrix.

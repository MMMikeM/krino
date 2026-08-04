# The benchmark machinery, visually

How a number gets from a fresh node process into a published table.
Companion to [benchmarks.md](./benchmarks.md) (the numbers), [measurement.md](./measurement.md) (how the harness came to be wrong, twice), and [pipeline.md](./pipeline.md) (ekrina's own query path).

## One `pnpm bench` run

```mermaid
flowchart TD
    CLI["pnpm bench --runs=10"] --> COLD["cold stage<br/>bench/run.ts: full matrix<br/>~30 tests × 14 variants × 2 sizes"]
    CLI --> QUAL["quality stage<br/>hits.test.ts — ranks/MRR, untimed<br/>session.test.ts — typing chain<br/>longtext.test.ts — junk guard"]

    COLD -->|".raw/cold-matrix.json"| ART[("bench/results.json<br/>the committed artifact")]
    QUAL -->|".raw/hits.json<br/>session.json · longtext.json"| ART

    ART --> REG["tables.ts regions()"]
    REG -->|"inject between<br/>&lt;!-- bench:id --&gt; markers"| DOC["docs/benchmarks.md"]
    ART --> SVG["docs/pareto.ts<br/>4 SVGs, both themes"]

    CHECK["pnpm bench --check"] -.->|"regenerate + diff,<br/>exit 1 on drift"| DOC
    DOCS["pnpm bench --docs"] -.->|"re-emit tables,<br/>no measuring"| DOC
```

Every published cell is reproducible from the artifact, and the artifact is committed, so a number that moves is a reviewable diff.

## Inside the cold stage: process-cold by construction

```mermaid
flowchart TD
    subgraph parent ["run.ts parent — bench &lt;variant&gt; &lt;test&gt; &lt;count&gt;"]
        MATRIX["expand matrix:<br/>tests × variants × sizes"] --> ROT["per repetition, rotate variant order<br/>(drift lands evenly, not on whoever ran last)"]
        ROT --> SPAWN["spawn child, one per sample"]
        SPAWN --> AGG["aggregate: median published,<br/>min + heap kept in the artifact"]
        AGG --> GUARDS{"guards"}
        GUARDS -->|"result counts differ across processes"| DIE1["throw — not comparable work"]
        GUARDS -->|"base ekrina slower than acronym"| DIE2["exit 1 — more code cannot be faster"]
        GUARDS -->|"first cell re-timed last, >25% drift"| WARN["warn — machine moved"]
    end

    subgraph child ["child — fresh node process, --expose-gc"]
        PARSE["parse corpus slice (untimed)"] --> GC["gc() — parse garbage<br/>must not land in the build window"]
        GC --> IDX["⏱ index: the constructor call"]
        IDX --> Q["⏱ each query's FIRST answer, in order"]
        Q --> OUT["JSON: indexMs, per-query ms + counts, heapMB"]
    end

    SPAWN --> PARSE
    OUT --> AGG
```

Nothing warm-loops.
The JIT, every per-searcher cache, and every process-wide cache (fuzzysort's prepare pool) start empty because the process is new — no cache busting, no subtraction, no calibration blind spots.

## What each cell means

```mermaid
flowchart LR
    subgraph oneshot ["one child's timeline"]
        direction LR
        A["parse<br/>(untimed)"] --> B["index<br/>constructor"] --> C["first answer<br/>(batch: warmup match)"] --> D["probes 1 … 20<br/>(batch test only)"]
    end

    B -->|"index ms"| I[("index")]
    C -->|"cold ms"| CQ[("cold query")]
    B & C -->|"summed, same child"| OS[("one-shot")]
    C & D -->|"total · first · rest-mean"| BA[("batch")]
```

- **index** — what the constructor builds: fast-fuzzy's trie is expensive here, ekrina allocates buffers, fuzzysort has no constructor at all.
- **cold query** — the first answer, every lazy slice unpaid: ekrina's raw-gate scan and rescue mask build, fuzzysort's prepare-all, microfuzz's first-search slice all surface here, per probe kind.
- **one-shot** — index + first answer summed inside one child's consecutive windows: the whole price of "given a list, get an answer".
- **batch** — a short-word warmup match, then the twenty distinct probes once each through one process: the realistic session, and the only warmth anywhere — earned by real queries, never repetition. The warmup absorbs JIT and first-scan cost; each probe's own post-warmup time feeds the per-probe tables' `batch ms` column.

## Where each published table draws from

```mermaid
flowchart LR
    CM[("coldMatrix<br/>corpus → kind → size → variant")] --> PT["per-probe tables (mixed 10k)<br/>index · cold · total · batch"]
    CM --> SC["scorecards (10k)<br/>index · cold · batch · batch/query"]
    CM --> ST["scale tables (100k)<br/>index · cold · batch · rels"]
    CM --> BT["build table<br/>constructors only"]
    CM --> PA["pareto charts<br/>x = batch/query · x = one-shot"]
    HITS[("hits.json<br/>ranks, counts")] --> PT
    HITS --> SC
    HITS -->|"MRR"| PA
    SESS[("session.json")] --> SES["session table<br/>typing `grady`, prefix cache"]
    LT[("longtext.json")] --> LTT["long-text table<br/>junk rate 0%"]
```

Ranks are deterministic, so quality is measured once, untimed; time and quality never contaminate each other's measurement.

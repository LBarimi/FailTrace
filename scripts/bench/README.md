# Benchmark implementation

Build Core, then run `node scripts/bench.mjs`. The default is six representative cases. See [performance guidance](../../docs/PERFORMANCE.md) for results, caveats and optimization decisions.

```sh
node scripts/bench.mjs --suite ci --check
node scripts/bench.mjs --experiments --hash
node scripts/bench.mjs --durations noop --repeats 10 --outputs 10KiB --predicates substring
```

`--suite full` explicitly opts into all 192 Core cases and 96 shared direct baselines: 79,992 target invocations, about 6.2 hours of target delay alone, and about 26.3 GiB of raw output before metadata. This is unsuitable for a routine CI job. Axis filters form a Cartesian product; unspecified axes retain their full set of values. Specify all four axes for a small custom run.

`--core` selects a built `dist/core/index.js`, allowing an unchanged release to be measured. The harness snapshots its Core directory once and records a JavaScript content digest so concurrent builds cannot mix implementations. `--label` accepts a short public label; `--output` selects a new directory on the filesystem being measured. Existing directories are refused before any writes inside them. Defaults are under `.failtrace/benchmarks/`. Reports omit local paths and environment values. Only `report.json` and `report.md` are uploaded by CI; fixture code, copied engine and raw run metadata remain local.

Each case has a new Node worker process. `instrument.mjs` loads through `--import` before Core and uses `syncBuiltinESMExports()` after wrapping `node:fs/promises`. It wraps opened FileHandles to count logical writes and sync calls. Calibration tests verify byte counts without double counting writes. CPU deltas exclude target and shell subprocesses; process peak RSS includes import/startup. Wall time excludes fixture preparation and import; `workerWallMs` includes process startup and teardown. Final artifact lengths are counted outside the timed region.

These are JavaScript filesystem API counts, not operating-system syscall counts or physical disk traffic. Direct-FD child output, synchronous/callback APIs, recursive internal operations, regex worker reads and kernel cache behavior are outside the hook. Successful logical metadata write bytes, attempted/completed fsync counts and final artifact sizes are distinct fields. Summing `promiseCalls` and `fileHandleCalls` gives counted parent API invocations. The harness intentionally avoids a misleading all-platform physical-I/O metric.

All targets exit 1. Positive output sizes contain the same sentinel; zero-byte substring/regex cases correctly record no match. Both direct baselines preserve environment, index, cwd, sequential execution, file redirection and target exit status. They skip predicate evaluation and metadata durability, measuring a lower-cost reference. Executable+argv avoids the shell while retaining a fresh Node target per trial.

CI requires metadata bytes at most `40,000 + 8,192 × repeat`, fsync calls at most `repeat + 8`, and at most 15-fold metadata growth when repetitions increase tenfold. The broad timing ceiling is eight times the direct-shell wall time plus three seconds. Missing instrumentation or structural cases fail the guard. Timing budgets are deliberately loose; structural checks catch the former quadratic rewriting independently of host speed.

`--experiments` adds six Core cases for threshold stopping and concurrency. `--hash` adds a warm-cache comparison experiment: ten real comparisons of two 16 MiB logs, one eager hash pass and a prototype cached lookup. The prototype omits cache validation, persistence and differing-output work, and assumes immutable logs. It is a cost floor, not a safe replacement implementation. Raw artifacts may be edited, so reusing saved hashes requires an explicit invalidation contract.

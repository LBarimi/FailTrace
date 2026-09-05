# Benchmark implementation

Build Core, then run `node scripts/bench.mjs`. The default is six representative cases. See [performance guidance](PERFORMANCE.md) for results, caveats and optimization decisions.

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

## Original workflow and checkpoint costs

After building the current source, run `node scripts/bench-workflows.mjs`. This separate harness requires the unreleased checkpoint and inventory APIs. Its defaults are three sequential samples, 2000 authored event records and five repeated trials per case. `--samples 1 --records 20 --repeat 1` provides a short harness check. Output must be a new directory; default output stays under `.failtrace/benchmarks/`.

Each sample has paired direct-shell, ordinary Core and checkpoint-enabled Core runs, with small or larger generated inputs and either zero or 1 MiB of preceding stdout. The importer and independent checker are the same original fixture across each pair. The checker scans records for every ID and has quadratic target work; target runtime is part of wall time. This is a controlled input-processing problem, not a naturally occurring production incident or failure-rate estimate.

A separate worker measures a complete investigation: baseline, JSON reduction, independent reduced check, bundle, actual replay, ineffective/unrelated/skipped/fixed patch controls, comparison and storage inventory. Every control's evidence is asserted before a measurement is accepted. An unrelated error or skipped check must remain inconclusive; the supplied patch must retain the latest revisions. All stage timings exclude fixture creation and source edits between stages.

Core and fixture files are copied once before sampling and hashed. The engine snapshot preserves its package layout and license so bundle creation tests the actual engine. All cases run sequentially in fresh workers and directories; import/setup time is outside per-operation wall time. Parent CPU excludes target/replay subprocesses, and RSS is the worker's lifetime peak, including earlier workflow stages. The existing I/O hook still measures JavaScript calls and logical bytes rather than physical device work. Direct shell lacks evidence validation and durable metadata.

`report.json` whitelists counts, status labels, digests and measurements, with min/median/max for each case/stage. Raw paths, commands, source patches, inputs and output remain in the private case directories. Cache state and other OS activity are not controlled. Do not run tests, installations or other benchmarks at the same time when collecting candidate results. Small timing differences require more evidence and are not portable performance claims.

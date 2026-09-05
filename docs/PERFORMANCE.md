# Performance and evidence

This document describes the performance changes in 0.4.0. Versions through 0.3.1 retain their original execution and metadata behavior.

## Execution controls

Ordinary runs default to one active trial and attempt all requested trials. Opt into overlap only when it suits the experiment:

```sh
failtrace run "npm test -- checkout" --repeat 20 --concurrency 4
```

The same setting is available as `runTrials({ command, repeat, concurrency })` and the MCP `failtrace_run` input. It is a positive safe integer; at most the requested number of trials can be active. Trial indices and artifact paths remain stable, terminal progress follows completion order, and returned trial arrays sort by index. `onTrialComplete` is notified after durable trial metadata is written and can return a promise. Cancellation stops scheduling and asks every active process tree to terminate; cleanup remains best effort.

Concurrency changes the experiment: shared databases, ports, files, memory, and CPU contention can change the failure probability. It is not a transparent speedup. Keep the setting with the evidence and compare equivalent execution settings. Bisect and minimize do not expose concurrency.

Bisect/minimize classify sequential trials with a threshold. For budget `N`, threshold `K`, observed matches `M`, and remaining trials `R`, they stop when `M >= K` or `M + R < K`. With `N=10, K=1`, the first matching trial decides reproduction; ten clean nonmatches are needed to decide absence. With `N=10, K=3`, eight initial nonmatches already make the threshold unreachable. These decisions save work without running trials concurrently. They establish a sampled threshold outcome, not statistical confidence or an unbiased full-budget failure rate. Infrastructure failures remain inconclusive. Minimization applies the same rule to its separate final verification.

The saved run retains `requestedTrials` and records `decision: { minFailures, outcome, completedTrials }` when classified. Ordinary `run` does not enable this stopping rule. Core callers can explicitly select the classification workload through `stopWhenDecided: { minFailures: K }`, with concurrency `1`; use ordinary repetition when measuring failure frequency.

Bundles preserve the recorded concurrency, predicate, timeout, and original requested trial count. Replay performs an ordinary full-count run even when the source was classified early. It reports whether at least one target match occurred; it does not reuse a bisect/minimize classification threshold.

## Metadata and recovery

Each `trials/<index>/result.json` is the authoritative record of a finished trial. Run-level metadata is persisted initially and at finalization. It is no longer serialized, rewritten, and synced in full after each trial. Statistics use a running accumulator for constant work per recorded trial.

Small finalized runs still use storage schema 1 and embed their trial arrays. At 1 MiB, final summaries use storage `schemaVersion: 2`, `trialStorage: "individual"`, and an empty embedded array before reaching the 32 MiB reader limit. Completed/interrupted compact summaries record `trialCount` and require exactly that many durable records on load. Compact error summaries omit the count to recover available records after a failed write while preserving error status. Initial running snapshots also use individual storage. `loadRun(reference)` accepts both storage versions and reconstructs index-sorted trials into the existing schema-1 in-memory summary; compare and bundle use that reader. Older FailTrace readers reject compact schema 2 rather than mistake an empty embedded array for completed evidence. After a crash, use the new reader instead of treating the initial raw `run.json` as live progress. A trial whose result was never durably written cannot be reconstructed. Older oversized embedded metadata remains subject to the reader limit.

This removes repeated growing run-summary writes, but trial records still require filesystem operations and durability work. Reconstruction reads those records and the returned summary uses memory proportional to the trial count. CLI JSON can therefore still be large. Parent `bisect.json` reports still embed candidate summaries; their size is a separate remaining scaling cost. MCP bounds returned lists; version 0.6.0 can page saved run trials and stdout/stderr byte ranges through `failtrace_inspect_run`, while other complete evidence remains at returned metadata paths. Logs and retained candidate inputs remain unbounded; monitor disk usage and clean inactive investigations according to your CI policy. No automatic cleanup, retention limit, or TTL is implemented.

File-set minimization requests copy-on-write/reflink copying where the filesystem supports it, with ordinary copying as the fallback. It still creates separate candidate files and never relies on hard links, so target writes do not alter the original input. Benefits depend on the filesystem and how much the target modifies copied data.

## Dependency setup during bisect

Each candidate restores its isolated worktree with `git reset --hard` and `git clean -ffdx`. Ignored dependency directories and build output are removed. Keep these operations: reusing mutable candidate output can produce a false regression boundary.

Reuse the package manager's download cache outside the repository/worktree instead. For npm, set `npm_config_cache` in the environment inherited by FailTrace and perform the locked install inside the target command. Replace the example cache path with an external directory appropriate to your machine.

POSIX shell:

```sh
npm_config_cache=/absolute/path/outside/repository/npm-cache failtrace bisect --good GOOD_REF --bad BAD_REF --command "npm ci --prefer-offline && npm test" --repeat 5 --min-failures 2
```

PowerShell:

```powershell
$env:npm_config_cache = 'C:/cache/failtrace-npm'
failtrace bisect --good GOOD_REF --bad BAD_REF --command "npm ci --prefer-offline && npm test" --repeat 5 --min-failures 2
```

This reuses package downloads while each candidate installs dependencies for its own lockfile. It does not preserve `node_modules`, guarantee offline availability, or cache build output. Setup inside the command runs for every executed trial and counts toward its timeout. Select a timeout that includes setup, and use a specific failure predicate so a setup failure is not mistaken for the target defect. No setup lifecycle or automatic dependency cache is implemented.

## Run the benchmarks

After building the source, run:

```sh
node scripts/bench.mjs
node scripts/bench.mjs --suite ci --check
node scripts/bench.mjs --suite full
node scripts/bench.mjs --experiments
node scripts/bench.mjs --hash
```

The default smoke suite is for a short local check; the full suite is opt-in. The matrix covers noop/10ms/100ms/1s targets, 1/10/100/1000 trials, 0 B/10 KiB/1 MiB output, and nonzero-exit/exit-code/substring/regex predicates. The full matrix includes 192 Core cases and 96 baselines: roughly 80,000 trials, 6.2 hours of nominal target sleep, and 28 GB of target output before metadata. Allow substantial additional startup time and disk space. Filters allow a narrower experiment; specify every axis because unspecified axes retain their full range:

```sh
node scripts/bench.mjs --durations noop,10ms --repeats 10,100 --outputs 0,10KiB --predicates nonzero_exit,substring
```

Reports are written under `.failtrace/benchmarks/<id>/report.json`. Each case runs in a fresh worker and measures wall time, FailTrace process CPU, process peak RSS, throughput, artifact size, logical metadata bytes, and instrumented filesystem operation/fsync counts. CPU excludes target subprocesses; peak RSS is for the measured process, not the complete process tree. Logical bytes and API call counts are not physical device I/O. Direct shell and executable baselines use equivalent target/output setup to expose startup costs. Filesystem, OS, Node version, target duration, and cache state affect the results; retain those conditions when comparing runs. Published reports must omit local host paths, credentials, and environment values.

Use `--output <new-directory>` to measure a selected local or CI filesystem; the destination must not already exist, even if empty. `--core <built-core-index>` selects a baseline build. Each invocation snapshots the selected Core and records a JavaScript content digest so a concurrent build cannot change the implementation between cases. See the [benchmark implementation notes](../scripts/bench/README.md) for instrumentation boundaries.

`--experiments` compares full-budget classification with threshold stopping and concurrency 1 with 4. `--hash` compares repeated full-log comparisons against a measurement-only eager-hash/cache prototype; the prototype is not a Core feature. CI uses four representative cases and checks logical metadata bytes `<= 40,000 + 8,192 × trials`, fsync count `<= 8 + trials`, a 100-versus-10-trial metadata growth ratio `<= 15`, and Core wall time `<= 8 ×` its direct-shell baseline `+ 3,000 ms`. These broad regression guards catch scaling mistakes without asserting a portable latency guarantee.

## Five-sample 0.5.0 measurement — 2026-09-05

These implementation measurements come from five complete benchmark reports run sequentially on the same Windows x64 host, OS release 10.0.19045, with Node.js 24.19.0. Every report used the same snapshotted Core JavaScript digest and passed the CI budget checks. Each run used this shape with a new output directory and label:

```sh
node scripts/bench.mjs --suite ci --check --experiments --output <new-directory> --label <label>
```

The fixed case order includes the CI structural cases followed by the full-budget, threshold and concurrency controls. The [sanitized five-sample evidence](benchmarks/readme-0.5.0-windows-node24-5-samples.json) retains all five observations for all 18 result IDs and records min, median and max for wall time, logical metadata writes, fsync calls and completed/matched trials. Its median is the third sorted observation. CPU, RSS, throughput, artifact-size and detailed API call counts are excluded from this aggregate. Raw `.failtrace/` directories, target output and local paths remain private and are not source files.

For 100 sequential no-output trials, an earlier same-host 0.3.1 sample wrote 3,132,662 logical metadata bytes. The five 0.5.0 samples range from 111,094 to 111,228 bytes, with a median of 111,141: 96.45% fewer than that single reference. This percentage compares one historical observation with the later five-sample median; it describes instrumented logical writes rather than timing or physical storage traffic.

Selected implementation measurements:

| Workload and setting | Median wall time (min–max) | Completed work and evidence |
| --- | ---: | --- |
| 100 no-op targets, direct shell baseline | 8.764 s (7.867–11.787) | 100 commands; no FailTrace evidence metadata |
| 100 no-op targets, FailTrace | 10.750 s (8.374–12.098) | 100 trials; 111,141 logical metadata bytes (111,094–111,228); 102 fsync calls |
| Ten 10 ms targets, full budget → threshold 1 | 1.275 s (0.995–1.331) → 0.124 s (0.111–0.157) | 10 → 1 trial; classification stopped after the first match |
| Ten 100 ms targets, concurrency 1 → 4 | 1.986 s (1.881–2.195) → 0.664 s (0.628–0.724) | All 10 trials retained in both runs |
| Ten 1 s targets, concurrency 1 → 4 | 11.047 s (10.968–11.185) → 3.380 s (3.345–3.525) | All 10 trials retained in both runs |

These are five fixed-order samples from one host, not randomized trials or portable performance guarantees. Filesystem, process load, Node version and target workload affect timing. Logical metadata bytes count successful parent-process writes, and fsync counts instrumented Node.js `sync`/`datasync` calls; neither is physical device I/O. Parent CPU and peak RSS exclude target and shell subprocesses.

The concurrency controls retain all ten outcomes but overlap target commands. Shared files, ports, services, CPU and memory can change failure behavior, so concurrency 1 and 4 are different experiments. The threshold control uses an always-matching target and `minFailures: 1`; its one completed trial establishes a decided classification, not a full-budget failure-rate estimate. Ordinary `run` does not use that stopping rule.

## Earlier single-sample implementation comparison — 2026-09-05

These are single maintainer samples on Windows x64, OS release 10.0.19045, Node.js 24.19.0, using the benchmark's local output directory. They compare the 0.3.1 implementation with source changes during this review. The [sanitized comparison report](benchmarks/windows-node24.json) collects before/after measurements; complete [baseline](benchmarks/baseline-0.3.1.json) and [source](benchmarks/source-review.json) reports include CPU, peak RSS, artifact size, throughput, and instrumented I/O. No other OS or filesystem performance claim follows from these samples.

Noop targets, no output, nonzero-exit predicate, sequential execution:

| Trials | Wall ms, 0.3.1 → source | Logical metadata bytes, 0.3.1 → source | fsync calls, 0.3.1 → source |
| --- | ---: | ---: | ---: |
| 10 | 1,328 → 914 | 56,562 → 13,228 | 22 → 12 |
| 100 | 9,572 → 9,764 | 3,132,662 → 111,055 | 202 → 102 |

The 100-trial case wrote **96.45% fewer logical metadata bytes**, but did not run faster in this timing sample. Its direct-shell baseline also varied from 8,634 to 9,182 ms. The structural I/O reduction is clear; repeated controlled timing samples are needed for a wall-time claim. After optimization, the noop 100-trial Core run spent 9,764 ms versus 9,182 ms for the direct-shell baseline, approximately 6.3% additional wall time in this sample. The direct-executable baseline took 6,225 ms, indicating startup cost worth investigating without changing the public command API yet.

Selected source-only control experiments use targets that always match:

| Experiment | Baseline wall ms | Optimized setting wall ms | Observations |
| --- | ---: | ---: | --- |
| 10 ms target, budget 10 | 1,183 | 139 with threshold 1 | 10 trials → 1; threshold classification, not a full frequency sample |
| 100 ms target, 10 trials | 1,969 | 634 with concurrency 4 | All 10 trials retained |
| 1 s target, 10 trials | 11,101 | 3,402 with concurrency 4 | All 10 trials retained |

For ten comparisons of two equal 16 MiB logs with a warm filesystem cache, the real compare API took 312.6 ms and reported 320 MiB of total output compared. A prototype hashing the 32 MiB once took 27.15 ms, followed by 0.15 ms for ten cached checks. The prototype assumes immutable logs and excludes hash persistence, artifact validation, and different-output diffs. This identifies a possible workload-specific optimization; it does not justify reusing hashes of editable evidence or adding JavaScript piping to every trial. Substring/regex benchmark cases also run with the existing capture path; no worker-pool or streaming-predicate speedup is claimed.

## Remaining tradeoffs

The benchmark separates costs before changing execution paths. The following are reviewed options, not implemented features:

| Candidate optimization | Tradeoff to measure |
| --- | --- |
| Executable plus argv mode | Can avoid shell startup; requires a separate API contract without changing existing command-string semantics. |
| Streaming substring checks | Avoids rereading logs but introduces JavaScript piping and backpressure instead of the existing direct file descriptors. |
| Reusable regex workers | May reduce worker startup; must retain the 16 MiB limit, evaluation timeout, and worker replacement after timeout. |
| Saved output hashes | Helps repeated comparisons but adds hashing cost to runs that are never compared; source-file changes also need a validity policy. |
| Output budgets and retention | Can bound disk growth; truncation must not silently change predicate results or remove needed evidence. |

The current implementation still uses a fresh platform shell for each trial, direct file descriptors for target output, streamed substring rereads, isolated regex workers, and on-demand comparison hashes. Choose bounded experiments and measure the actual CI filesystem before applying FailTrace to every test invocation.

# Performance and evidence

This document describes execution controls, measurements of the **unreleased source candidate**, and explicitly versioned historical measurements. Older releases retain their original behavior. A historical optimization result is not a measurement of the current engine.

## Unreleased execution and evidence changes

Fresh substring failure predicates and completion checkpoints are matched while bounded output is successfully written. This removes their separate post-run output reads. UTF-8 decoding and matches crossing chunk boundaries are preserved; a match seen before truncation, timeout or storage failure cannot establish complete evidence. Saved-run verification continues to read the retained output, so it does not trust a stale match after a log edit.

The opt-in [direct execution mode](DIRECT-EXECUTION.md) passes an executable and literal argument array without starting a platform shell. Shell mode remains the default. Mode and arguments are preserved in evidence and compared by Verify; changing the mode is an experiment change, not a transparent optimization.

Comparison hashes a finite regular-file snapshot and collects its bounded preview from the same bytes. It handles short reads and rejects observed growth or replacement. Regex workers recheck size and bound reads after opening the file. These changes preserve complete evidence without a persisted hash cache or reduced durability policy. Measurements below retain their recorded source digests and do not automatically describe these newer changes.

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

Version 1.0 replaces direct output file descriptors with bounded streaming pipes and bounds managed minimization input copies. File-set copies use bounded streaming snapshots instead of the earlier reflink optimization. Generated run records and saved-run reconstruction also have aggregate limits; bisect schema 2 references candidate trial files instead of embedding their full arrays. See [resource budgets and migration details](RESOURCE-LIMITS.md). Historical measurements describe their recorded versions, not these changed I/O paths.

Each `trials/<index>/result.json` is the authoritative record of a finished trial. Run-level metadata is persisted initially and at finalization. It is no longer serialized, rewritten, and synced in full after each trial. Statistics use a running accumulator for constant work per recorded trial.

Small finalized runs still use storage schema 1 and embed their trial arrays. At 1 MiB, final summaries use storage `schemaVersion: 2`, `trialStorage: "individual"`, and an empty embedded array before reaching the 32 MiB reader limit. Completed/interrupted compact summaries record `trialCount` and require exactly that many durable records on load. Compact error summaries omit the count to recover available records after a failed write while preserving error status. Initial running snapshots also use individual storage. `loadRun(reference)` accepts both storage versions and reconstructs index-sorted trials into the existing schema-1 in-memory summary; compare and bundle use that reader. Older FailTrace readers reject compact schema 2 rather than mistake an empty embedded array for completed evidence. After a crash, use the new reader instead of treating the initial raw `run.json` as live progress. A trial whose result was never durably written cannot be reconstructed. Older oversized embedded metadata remains subject to the reader limit.

This removes repeated growing run-summary writes, but trial records still require filesystem operations and durability work. Reconstruction reads those records and the returned summary uses memory proportional to the trial count. CLI JSON can therefore still be large. Through published 0.6.0, parent `bisect.json` reports embed full candidate runs and logs/input copies have no aggregate allowance. Version 1.0 adds the limits and compact candidate references described above. MCP bounds returned lists; version 0.6.0 can page saved run trials and stdout/stderr byte ranges through `failtrace_inspect_run`, while other complete evidence remains at returned metadata paths. Monitor disk usage and clean inactive investigations according to your CI policy; no automatic cleanup, retention schedule, or TTL is implemented.

Version 1.0 file-set minimization streams bounded copies and checks the source before and after each copy. Candidate files are separate from the original input, so target writes do not modify the original through a hard link. Copy cost grows with retained bytes and the selected filesystem; the earlier reflink optimization is historical.

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

This reuses package downloads while each candidate installs dependencies for its own lockfile. It does not preserve `node_modules`, guarantee offline availability, or cache build output. Setup inside the command runs for every executed trial and counts toward its timeout. Select a timeout that includes setup, and use a specific failure predicate so a setup failure is not mistaken for the target defect. No setup lifecycle or automatic dependency cache is implemented. Since 1.1.0, Bisect also requires healthy exits for nonmatching trials and supports explicitly declared inconclusive exits; see the [exit-policy migration note](COMPATIBILITY.md#migration-review-for-110-bisect-safety-changes).

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

Use `--output <new-directory>` to measure a selected local or CI filesystem; the destination must not already exist, even if empty. `--core <built-core-index>` selects a baseline build. Each invocation snapshots the selected Core and records a JavaScript content digest so a concurrent build cannot change the implementation between cases. See the [benchmark implementation notes](BENCHMARKS.md) for instrumentation boundaries.

`--experiments` compares full-budget classification with threshold stopping and concurrency 1 with 4. `--hash` compares repeated full-log comparisons against a measurement-only eager-hash/cache prototype; the prototype is not a Core feature. CI uses four representative cases and checks logical metadata bytes `<= 40,000 + 8,192 × trials`, fsync count `<= 8 + trials`, a 100-versus-10-trial metadata growth ratio `<= 15`, and Core wall time `<= 8 ×` its direct-shell baseline `+ 3,000 ms`. These broad regression guards catch scaling mistakes without asserting a portable latency guarantee.

## Unreleased candidate: original workflow costs — 2026-09-05

Three sequential samples measured the Core at `5ac3ac78689a54d919c9c618ed31906d22eb6507`, including execution checkpoints and artifact inventory. The copied Core JavaScript digest was `e6f0962627fb44dcf919b395db60a7cccdb59a7418931a7ca6f09e2b87bbc4ae`. This is **unreleased source**, not a measurement of the npm 1.1.0 package.

The [aggregate record](benchmarks/unreleased-workflows-windows-node24.json) contains selected configuration, digests, methods and min/median/max observations. Raw commands, paths, inputs, logs and per-worker files remain private. The environment was Windows x64, Node.js 24.19.0. No tests, package installation or other FailTrace benchmark ran concurrently. Case order was fixed, and filesystem caches and background OS activity were not controlled.

The authored importer loses later revisions for duplicate IDs. Generated batches contain two revisions per ID; the independent checker scans records for every ID, so its own target work is quadratic. Each paired case runs the same command five times. The high-output case writes 1 MiB of stdout before the completed-check marker. These are controlled input-processing examples; they do not estimate production failure probability or an independent user's debugging time.

| Five target executions | Direct shell median | Core median | Core with checkpoint median (min–max) |
| --- | ---: | ---: | ---: |
| 12 records, no preceding stdout | 0.412 s | 0.578 s | 0.561 s (0.555–0.579) |
| 2000 records, no preceding stdout | 0.573 s | 0.728 s | 0.729 s (0.702–0.744) |
| 2000 records, 1 MiB preceding stdout per trial | 0.573 s | 0.765 s | 0.737 s (0.723–0.769) |

The direct shell preserves output but omits predicates, checkpoint validation and durable metadata. Core adds observable execution/evidence cost on these short targets. The small differences between checkpoint-enabled and ordinary Core overlap sample variation; they establish neither a speedup nor negligible overhead. All ordinary and checkpoint-enabled Core cases retained seven sync calls per five-trial run; checkpoint fields increased recorded metadata slightly.

The same candidate also completed a larger investigation in each sample. It reduced **2000 records to two** through 63 evaluations and independently reproduced the result. All three ineffective patches still reproduced the target; all unrelated-error and skipped-check controls were inconclusive; all supplied valid patches had no target observed in their healthy five-trial sample. Every bundle replay reproduced the reduced failure.

Selected operation medians were 0.742 s for baseline capture, 8.483 s for minimization, 0.825 s for valid-patch Verify, 0.118 s for bundle creation, 0.317 s for replay, and 0.522 s for inventory of the resulting evidence. The completed workflow retained 452 evidence files and about 1.22 MB of logical evidence. Minimization wrote about 2.68 MB of metadata over its 63 evaluations and made 254 sync calls; cumulative writes exceed retained bytes because investigation reports are updated. These costs justify finite evaluation/storage budgets.

Per-operation wall time includes subprocess execution and evidence persistence but excludes worker import, fixture preparation and source edits between stages. Parent CPU excludes target and replay subprocesses; RSS is a worker-lifetime peak. I/O counters describe instrumented JavaScript calls and logical writes, not physical disk operations. These observations are scope-limited checks of cost and correct evidence, not a portable performance guarantee.

The existing `--suite ci --check --experiments` guard also passed against this same Core digest with no budget failures. Reproduce workflow measurements with `npm run build` followed by `node scripts/bench-workflows.mjs`. See the [harness notes](BENCHMARKS.md#original-workflow-and-checkpoint-costs) for bounded options and methodology.

## Three-sample 1.0.0 cost check — 2026-09-05

Three sequential runs used the unchanged 1.0.0 Core from source revision `7ff75fc533969812ad3854f7d809fbe7692b7347`. Before timing, all 28 Core JavaScript files were compared byte-for-byte with a fresh installation of the public npm 1.0.0 package. The benchmark's Core digest was `7871fc97f742aa485714f1f9f0da3c97d6501f6744a79179c15f16e5d22ad3c3` in every sample.

The environment was Windows x64 with Node.js 24.19.0. Each invocation used `--suite ci --check --experiments` with the verified Core snapshot and a new output directory. No FailTrace test suite or package installation ran during timing. Case order was fixed; filesystem cache state and background system load were not controlled. These are small synthetic implementation checks, not an isolated production benchmark.

The [sanitized three-sample record](benchmarks/core-1.0.0-windows-node24-3-samples.json) includes every observation and min/median/max for wall time, parent CPU/RSS, logical metadata writes, fsync calls, artifact bytes, and completed trials. The median is the second sorted observation. Paths, command strings, target logs, environment values and host identifiers remain private.

Selected sequential cases, with no intentional target delay:

| Workload | Direct shell median (min–max) | FailTrace median (min–max) |
| --- | ---: | ---: |
| 10 trials, no output, nonzero-exit predicate | 0.875 s (0.838–0.891) | 1.227 s (1.131–1.248) |
| 100 trials, no output, nonzero-exit predicate | 8.349 s (8.265–8.889) | 11.535 s (11.161–12.306) |
| 10 trials, 10 KiB output each, substring predicate | 0.842 s (0.820–0.936) | 1.195 s (1.167–1.211) |
| 10 trials, 1 MiB output each, regex predicate | 0.826 s (0.819–0.940) | 1.536 s (1.477–1.586) |

The direct-shell reference captures output through file descriptors but does not evaluate FailTrace predicates or write durable trial metadata. For 100 no-output trials, the difference between medians was 3.186 seconds, about 32 ms per trial or 38% additional wall time. That is noticeable for very short targets and does not support a blanket claim of negligible overhead. It is not an evidence-equivalent comparison with another debugging product.

For that 100-trial Core case, medians were 111,389 logical metadata bytes, 102 fsync calls, 1,126 ms of parent CPU and 57.1 MiB of parent peak RSS. The 1 MiB regex case used 470 ms of parent CPU and 70.5 MiB of parent peak RSS. CPU excludes shell/target subprocesses; RSS is a process-lifetime peak, not the whole process tree. Wall times exclude CLI, MCP, npm and dependency-install startup. API write/fsync counts are not physical device I/O.

All three reports passed the broad existing regression budgets, including metadata growth from 10 to 100 trials. The record also retains threshold and concurrency controls, with their different completed-work and experiment semantics. Passing those budgets does not prove acceptable latency for every workload. Measure your actual target and filesystem before applying repeated evidence capture to every test; no Core optimization or competing-tool superiority is claimed from these samples.

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
| Streaming substring checks | Could avoid substring rereads by matching inside the existing bounded capture pipeline; must preserve chunk boundaries, output-limit semantics and backpressure. |
| Reusable regex workers | May reduce worker startup; must retain the 16 MiB limit, evaluation timeout, and worker replacement after timeout. |
| Saved output hashes | Helps repeated comparisons but adds hashing cost to runs that are never compared; source-file changes also need a validity policy. |
| Retention of old investigations | Managed output and copy budgets already exist. Removing inactive historical investigations needs an explicit policy that preserves active and referenced evidence. |

Version 1.0 uses a fresh platform shell for each trial, bounded stdout/stderr pipes with backpressure, streamed substring rereads, isolated regex workers, and on-demand comparison hashes. Choose bounded experiments and measure the actual CI filesystem before applying FailTrace to every test invocation.

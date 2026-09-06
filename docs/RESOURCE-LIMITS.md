# Experiment resource limits

**NUnit integration in 1.3.0:** XML reads are limited to 4 MiB per report, with 10,000 cases, 100,000 elements and 64 nesting levels. Target-written XML is separate from piped stdout/stderr budgets and no filesystem quota is implied. See [NUnit evidence limits](UNIT-TESTS.md#evidence-and-limits).

These controls require FailTrace 1.0 and are absent from 0.6.0. See [installation and publication status](../README.md#quick-start) when selecting a package version.

Repeated commands can emit unlimited output even when their input is small. An unattended debugging agent needs a finite evidence allowance and an explicit outcome when evidence is incomplete.

| Option | Default | Scope |
| --- | --- | --- |
| Core/MCP `maxOutputBytes`, CLI `--max-output-bytes` | 16777216 (16 MiB) | Combined stdout and stderr retained for one trial |
| Core/MCP `maxTotalOutputBytes`, CLI `--max-total-output-bytes` | 268435456 (256 MiB) | Combined output across one run, or all runs in one bisect/minimization |

Values are positive safe integers in bytes. Limits apply by default, including on concurrent runs. Larger limits are explicit choices; zero does not disable protection. A process that writes exactly the allowance and exits has complete output. The next byte exceeds it. Both streams and concurrent trials share their allowance; the distribution between streams depends on observed output arrival order.

```sh
node dist/cli/index.js run "node reproduce.js" --repeat 20 --max-output-bytes 1048576 --max-total-output-bytes 16777216 --json
```

FailTrace pipes output through bounded buffers with backpressure, retaining only bytes within the allowance. This can affect command timing and throughput, so use the same execution settings when comparing experiments. A truncated UTF-8 sequence stays as raw bytes in the saved file; decoders may show a replacement character.

## Incomplete evidence is inconclusive

When a cap is exceeded, the active process tree is stopped using the existing bounded best-effort cleanup, unstarted trials are skipped, and partial logs plus metadata are preserved. Run status is `resource_limited`; the affected trial has status `resource_limited`, termination reason `output_limit`, and `outputLimit: { scope, limitBytes }`. No target match or clean nonmatch is inferred from that trial, even if the retained prefix contains a matching message. `assessRun` returns `inconclusive`. Other trials that had already completed retain their own observations.

A failure writing command output has trial status and termination reason `output_error`, and run status `error`. The trial carries its error. It cannot become clean exit evidence. If the metadata filesystem is also unavailable, persistence can fail; no filesystem writer can promise durable evidence after disk loss.

CLI `run` returns exit 2 for these outcomes and prints the artifact location. MCP returns structured evidence with the status and limit details. Saved inspection includes these trials in the `unhealthy` filter. A failure rate still counts execution failures; it is not a target-match rate or a success verdict.

Bisect shares the total allowance across endpoints and candidates and stops inconclusively on incomplete execution. Minimize shares it across baseline, reductions and final checks. Once output is incomplete, it stops evaluating candidates and does not claim independent final verification. An evaluation-count limit and an output limit have different effects: the former reserves a final recheck; the latter cannot supply clean evidence for one.

## Verify and replay

Verify inherits both output caps from its baseline. Overrides require an explicit `outputLimits` change allowance and reason, just like changes to timeout or concurrency. Baselines made before output caps existed have unknown caps: capture a new baseline or explicitly acknowledge that change. Allowing different caps never makes a truncated candidate eligible for a healthy verdict.

```sh
node dist/cli/index.js verify <baseline> --command "node reproduce.js" --cwd . --max-output-bytes 33554432 --allow-change "outputLimits:allow the reviewed additional diagnostics" --json
```

Bundles record the source run's caps and replay with them. Older source runs use the new finite defaults. Replay returns 2 when evidence is inconclusive, including output exhaustion. No target command executes while creating a bundle.

## Resource scope

Output byte budgets do not account for metadata, copied minimization inputs, Git worktrees, dependency installations, files written directly by the target, or previous investigations. The budgets below separately bound managed input copies and run metadata. They are not a total filesystem quota. No automatic deletion or retention schedule is applied.

Version 1.2.0 provides a [bounded read-only inventory](ARTIFACTS.md) of accumulated storage and known evidence links. Scan completeness and reported state do not grant deletion authority.

Commands still run with local permissions. Timeout and descendant cleanup remain best effort, and a target can use files or processes outside these output pipes. Review sensitive output before sharing evidence.

Bundle creation has a separate complete-copy allowance: Core/MCP `maxBundleBytes`, CLI `--max-bundle-bytes`, default 512 MiB. It includes selected source/input, optional original evidence, the engine, replay documents and manifest. See [bundle sharing and copy limits](BUNDLES.md).

## Minimization input storage

| Option | Default | Scope |
| --- | --- | --- |
| Core/MCP `maxInputBytes`, CLI `--max-input-bytes` | 16777216 (16 MiB) | Original file or complete directory, and each encoded candidate |
| Core/MCP `maxCandidateBytes`, CLI `--max-candidate-bytes` | 268435456 (256 MiB) | Cumulative bytes copied into original, candidate and selected-input files |

Both values are positive safe integers. File-set inputs have at most 10000 files and 10000 traversed entries in total, including empty directories. Directory and JSON nesting is limited to 64 levels. Text inputs have at most 1000000 Unicode code points. JSON inputs have at most 100000 containers, scalar values and object keys combined; punctuation inside strings does not count. Environment inputs additionally have at most 10000 keys. These fixed complexity ceilings apply even when the byte allowance is raised, because a small encoded file can otherwise expand into millions of reduction units.

Input reads are byte bounded, and JSON complexity is checked before parsing and allocating its tree. Oversized inputs are rejected before target execution or investigation creation; originals remain untouched. Copies use exclusive destinations and bounded streaming reads; growth or replacement during a read is rejected. This replaces the published copy-on-write optimization so a changing source cannot silently enlarge a managed copy beyond its reserved allowance. Filesystem I/O costs can therefore differ from the historical measurements.

Exhausting the copy allowance returns `status: "limit_reached"`, `finalVerified: false`, and `storageLimit` with the allowance, bytes reserved and rejected request. CLI exits 2. `minimizedPath` points to an existing best available input: the last accepted candidate, or the preserved original when no reduction was accepted. An independent final check is not claimed. Previously completed candidate evidence and the original user input remain intact; even partial rejected copies count against the allowance.

If the original input itself is larger than the requested input or copy allowance, validation fails before creating an investigation. Target-written files, later modifications by the target, metadata and output logs are outside this copy counter; output has its own budget. Limits do not grant filesystem isolation or automatically delete earlier investigations.

## Metadata and scheduling

These fixed limits apply to version 1.0:

| Limit | Maximum | Scope |
| --- | --- | --- |
| Command | 64 KiB UTF-8 | One command; use a project-owned script for longer commands |
| Requested trials | 100000 | One run or candidate run |
| Concurrency | 64 | Active trials in a run; the default remains 1 |
| Minimization evaluations | 10000 | Baseline, reductions and final check combined; the default remains 200 |
| Metadata document | 32 MiB | Each atomic JSON write and each run/trial document read |
| Generated run metadata | 96 MiB | Retained run headers and individual trial records across a run, bisect or minimization |
| Reconstructed metadata | 96 MiB and 100000 trials | One saved run, including the header and all loaded individual records |

Before a run starts, the writer reserves 32 MiB for its terminal header. Each trial reserves its maximum encoded record before command execution. After persistence, unused reservation is returned and stored bytes remain charged. This means scheduling can stop before 96 MiB is actually written: reserved headroom is required to preserve a terminal checkpoint. Already reserved concurrent trials may finish normally. Failed persistence attempts conservatively consume their reservation.

When another trial cannot be reserved, the run records `status: "resource_limited"` and `metadataLimit: { limitBytes, usedBytes, reservedBytes, requiredBytes }`. Existing observations remain valid individually, but `assessRun` and Verify cannot classify the incomplete sample as healthy evidence. There is no synthetic failed trial for work that never started. CLI exits 2 and MCP includes the limit details. If the next candidate cannot reserve a run header, bisect returns `inconclusive`; minimization returns `limit_reached`, retains its best existing input and cannot claim final verification.

The counter measures encoded bytes, not process RSS or filesystem allocation. Reconstructing JavaScript objects and printing CLI JSON require additional memory. Atomic replacement temporarily retains both the old document and its replacement. Investigation-level reports have their own 32 MiB per-document ceiling; they are outside the run-record counter. No writer can guarantee a final checkpoint if the filesystem itself stops accepting writes.

Bisect schema 2 records compact candidate evidence with `trialCount`, `matchedTrials`, settings, statistics and `metadataPath`; it no longer retains each candidate's full `trials` array in the parent result. Retrieve the complete saved run with `loadRun(candidate.run.metadataPath)`, or use `failtrace_inspect_run` for bounded agent responses. The source commit remains with the saved run, so selecting source files for a reproduction bundle continues to work after worktree cleanup.

The reader accepts both stored run schemas 1 and 2 within these byte/count bounds, including crash recovery. Older incomplete runs may have a larger requested count if their actually recorded data fits. Oversized historical records fail explicitly; they are neither silently truncated nor deleted. Long internal diagnostics are shortened to at most 2048 characters in newly generated records, with a truncation marker; their failure status is retained. Commands and target output are governed by their separate limits.

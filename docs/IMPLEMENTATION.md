# Implementation and verification

FailTrace 0.2.0 implements all six milestones. CLI and MCP delegate to the reusable Core; only MCP imports the official SDK.

Version 0.4.0 adds optional run concurrency, sequential threshold stopping for bisect/minimize, incremental run statistics, and reconstruction from authoritative per-trial records. See [performance guidance and benchmarks](PERFORMANCE.md). These changes are separate from the historical 0.2.0/0.3.0 verification results below.

Version 0.5.0 implements dedicated code-fix verification in Core, CLI and MCP. It requires eligible full-budget baseline evidence with captured context, an explicit current command and working directory, healthy candidate execution and declared interventions. It returns observed outcomes and a durable report; it does not claim that a defect was eliminated or statistically improved. Minimization's `finalVerified` still means only that the reduced input reproduced the selected failure. See the [Verify workflow and limits](VERIFY.md).

Version 0.6.0 adds bounded, read-only inspection of complete saved run trials and stdout/stderr byte ranges through public Core and MCP. Inspection never executes the saved command, and target output remains untrusted evidence.

Version 1.0 adds bounded output (`output-budget.ts`, `runner.ts`), retained input and pre-parse complexity guards (`input-budget.ts`, `input-complexity.ts`, `minimize-input.ts`), bounded metadata and reconstruction (`metadata-budget.ts`, `run-metadata.ts`, `run-reader.ts`), and compact schema-2 bisect evidence. Reviewable bundle sharing is implemented by `bundle.ts`, `bundle-files.ts` and `bundle-environment.ts`. These modules remain in Core. The [compatibility contract](COMPATIBILITY.md) and [migration guide](MIGRATING-TO-1.md) cover the public behavior and breaking changes.

Archive identities, CI runs and public installation checks are recorded once in [release validation](RELEASE-VALIDATION.md).

## Required outcomes

- M2: explicit exit-code, stdout/stderr substring and regex predicates; inspectable selected environment snapshots; compare saved runs and successful/failed trial outputs with bounded text diffs and stream hashes.
- M3: Git regression isolation in a separate temporary worktree; verify good/bad endpoints using repeated trials and a failure threshold; preserve candidate evidence, handle inconclusive/interrupted searches, never change the user's checkout.
- M4: deterministic delta debugging of text, structured JSON/arrays, file sets and environment selections; accept only candidates that still reproduce under the chosen predicate and trial threshold; preserve originals, baseline/final validation and candidate evidence, cancellation and evaluation limits.
- M5: self-contained local reproduction directories with metadata, selected source/input files, logs, README, Node replay and sh/cmd wrappers; portable relative paths, no implicit execution on import, no unrelated files overwritten, replay verification.
- M6, Verify, and inspection adapter: current official MCP SDK over stdio; seven tools (`failtrace_run`, `failtrace_inspect_run`, `failtrace_compare`, `failtrace_bisect`, `failtrace_minimize`, `failtrace_verify`, `failtrace_bundle`); thin Core calls, typed schemas, cancellation, structured results and clean protocol output; real SDK client integration tests.
- CLI/API coverage for each feature; help, deterministic examples and current README match implemented behavior.
- Unit/integration tests, typecheck, build, packaging, manual workflow checks, and six Windows/macOS/Linux × Node 22/24 CI jobs pass on the final commit.

## Verification

- Milestone 1 baseline: `66736cd`, with 70 tests and six passing CI jobs.
- Full 0.2.0 local suite: 186 tests across 12 files passed; TypeScript checking and production build passed.
- The packed npm artifact was installed into a separate local prefix. Its executable and public Core exports worked; an official SDK client discovered all five MCP tools and reproduced a target failure through the installed server.
- An installed-CLI workflow recorded four passing and two failing trials, compared their evidence, reduced a JSON input to `["BUG"]`, replayed the copied bundle with one match in three trials, and identified a known regression in a disposable Git repository.
- Integration coverage verifies that bisect evidence can export committed source, binary bytes, and executable modes after worktree cleanup while preserving the caller's dirty checkout. Replay also works after moving a bundle and removing its original source/artifacts, including launch through directory aliases such as macOS temporary paths and Windows junctions.
- CI runs typecheck, all tests, build, and package checks on Windows/macOS/Linux with Node.js 22 and 24. The workflow attached to each commit records the cross-platform result.

## Boundaries

Bisect classifies sampled first-parent history under a monotonicity assumption. Minimization removes text units, JSON members, files, or environment keys; it does not prove global minimality or shrink JSON scalar values. Bundles contain selected local files and an included Core engine, while target dependencies, services, and uncaptured environment state require their own setup. See the README for predicate limits and process-cleanup behavior.

[Documentation index](README.md)

## Saved record layout

Individual storage uses each completed trial's `result.json` as its authoritative record; schema-1 storage reads the trials embedded in its header. `run.json` is written initially and at finalization rather than rewritten after every trial. A running snapshot or a large final summary uses on-disk `schemaVersion: 2`, `trialStorage: "individual"`, and an empty embedded trial array. Completed/interrupted compact summaries record `trialCount`, and loading requires that exact number of records. Compact error summaries omit this count because a failed write may have left fewer durable records; loading recovers those records while preserving the error status. Use the public `loadRun(reference)` API, also used by compare/bundle, to reconstruct index-sorted evidence from individual results. It accepts storage versions 1 and 2 and returns the existing schema-1 in-memory summary. Versions before 0.4.0 cannot read compact storage. Raw `run.json` alone may show stale progress after a process crash; reconstruction cannot recover a trial result that was never durably written.

Small final summaries retain storage schema 1 and embedded trials for compatibility. At 1 MiB, new final summaries switch to individual storage before reaching the 32 MiB per-document reader limit. Version 1.0 additionally bounds aggregate reconstruction and writes schema-2 `bisect.json` reports with compact candidate descriptors; use `loadRun(candidate.run.metadataPath)` for their individual trials. Published 0.6.0 still embeds candidate summaries and does not cap output files or retained candidates. See the [new resource limits](RESOURCE-LIMITS.md), [compatibility contract](COMPATIBILITY.md) and [0.x migration](MIGRATING-TO-1.md).

# Implementation and verification

FailTrace 0.2.0 implements all six milestones. CLI and MCP delegate to the reusable Core; only MCP imports the official SDK.

Version 0.4.0 adds optional run concurrency, sequential threshold stopping for bisect/minimize, incremental run statistics, and reconstruction from authoritative per-trial records. See [performance guidance and benchmarks](PERFORMANCE.md). These changes are separate from the historical 0.2.0/0.3.0 verification results below.

Version 0.5.0 implements dedicated code-fix verification in Core, CLI and MCP. It requires eligible full-budget baseline evidence with captured context, an explicit current command and working directory, healthy candidate execution and declared interventions. It returns observed outcomes and a durable report; it does not claim that a defect was eliminated or statistically improved. Minimization's `finalVerified` still means only that the reduced input reproduced the selected failure. See the [Verify workflow and limits](VERIFY.md).

Version 0.6.0 adds bounded, read-only inspection of complete saved run trials and stdout/stderr byte ranges through public Core and MCP. Inspection never executes the saved command, and target output remains untrusted evidence.

Version 1.0 adds bounded output (`output-budget.ts`, `runner.ts`), retained input and pre-parse complexity guards (`input-budget.ts`, `input-complexity.ts`, `minimize-input.ts`), bounded metadata and reconstruction (`metadata-budget.ts`, `run-metadata.ts`, `run-reader.ts`), and compact schema-2 bisect evidence. Reviewable bundle sharing is implemented by `bundle.ts`, `bundle-files.ts` and `bundle-environment.ts`. These modules remain in Core. The [compatibility contract](COMPATIBILITY.md) and [migration guide](MIGRATING-TO-1.md) cover the public behavior and breaking changes.

The public [1.0.0-rc.1 candidate](https://github.com/LBarimi/FailTrace/releases/tag/v1.0.0-rc.1), commit `b291d84244fe3b2b3fbed822dca1964ac6006d1b`, passed 366 tests, type checking, build, eleven installed-package check groups and all seven [CI gates](https://github.com/LBarimi/FailTrace/actions/runs/33943581907). Those gates preserve the six OS/Node combinations and add a Linux package installation on the minimum Node 22.12.0. Its public archive SHA-256 is `5671558ae3a7accea6cf07a5c55d27be13695a24804ff34f87c944a8b4410464`; anonymous download, a fresh-cache public URL install, the full demo, manifest hashes and bundle replay were verified. The final archive was verified separately using the [release procedure](RELEASING.md).

The final [1.0.0 release](https://github.com/LBarimi/FailTrace/releases/tag/v1.0.0) uses commit `8a6c0ed6bbcfec56be1c99d3123bf8dd6a02cc59`, which passed 366 tests and all seven [CI gates](https://github.com/LBarimi/FailTrace/actions/runs/33945341915). Archive SHA-256 `f7793d39ce5083c7030d9dc1da2a189b91e922bec65684f52366a8dd9fe4d913` matched both public GitHub and npm downloads. Fresh npm installations and the exact-version npx demo verified Core, Verify controls, saved-evidence pagination, bundle manifests and replay. The installed MCP server listed all seven tools; calls exercised run limits, Verify and saved-trial/output inspection. The [versioned MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.LBarimi%2Ffailtrace/versions/1.0.0) is active. These are maintainer distribution checks; independent use remains unverified.

Version [1.1.0](https://github.com/LBarimi/FailTrace/releases/tag/v1.1.0), commit `c7f9e7ce3ebc36b5e72fc9ee88cfbc57ff73781c`, passed 374 tests and all seven [CI gates](https://github.com/LBarimi/FailTrace/actions/runs/33954024895). Archive SHA-256 `dd52ef2a36ade281c6795fb708765f4f6da509b31f9fce3e10f7d559c68237bb` matched the reviewed GitHub asset and the public npm download. Fresh-cache installations exercised the demo, Core, CLI, Verify, saved inspection, bundle manifests and replay. Additional installed CLI/MCP checks verified target-first comparison and Bisect's unrelated/declared exit guards. The server listed all seven tools; calls exercised run limits, comparison, Bisect, Verify and saved inspection. The [1.1.0 MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.LBarimi%2Ffailtrace/versions/1.1.0) is active. These are distribution checks, not evidence of independent adoption.

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

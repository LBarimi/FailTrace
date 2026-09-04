# Implementation and verification

FailTrace 0.2.0 implements all six milestones. CLI and MCP delegate to the reusable Core; only MCP imports the official SDK.

## Required outcomes

- M2: explicit exit-code, stdout/stderr substring and regex predicates; inspectable selected environment snapshots; compare saved runs and successful/failed trial outputs with bounded text diffs and stream hashes.
- M3: Git regression isolation in a separate temporary worktree; verify good/bad endpoints using repeated trials and a failure threshold; preserve candidate evidence, handle inconclusive/interrupted searches, never change the user's checkout.
- M4: deterministic delta debugging of text, structured JSON/arrays, file sets and environment selections; accept only candidates that still reproduce under the chosen predicate and trial threshold; preserve originals, baseline/final validation and candidate evidence, cancellation and evaluation limits.
- M5: self-contained local reproduction directories with metadata, selected source/input files, logs, README, Node replay and sh/cmd wrappers; portable relative paths, no implicit execution on import, no unrelated files overwritten, replay verification.
- M6: current official MCP SDK over stdio; five tools (`failtrace_run`, `failtrace_compare`, `failtrace_bisect`, `failtrace_minimize`, `failtrace_bundle`); thin Core calls, typed schemas, cancellation, structured results and clean protocol output; real SDK client integration tests.
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

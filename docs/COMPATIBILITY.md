# Compatibility contract for 1.0

## Unreleased execution checkpoints

The source checkout supports opt-in `executionRequirement` metadata and per-trial `executionMatched` evidence. Default behavior, existing status values and predicate statistics are preserved. A selected requirement changes classification: missing or unknown completion is inconclusive, including target-matching trials. Verify inherits the baseline condition and replay bundles include it. Use a build that supports checkpoints throughout this workflow; published 1.1.0 readers do not enforce these additional fields. See the [complete contract and example](EXECUTION-EVIDENCE.md).

This contract defines the supported surfaces for FailTrace 1.x. See [migration from 0.x](MIGRATING-TO-1.md) before upgrading. Publication status and available installation routes are recorded in the [README](../README.md#quick-start); a version in a checkout does not by itself establish public registry availability.

## Supported integration surfaces

| Surface | Contract for stable 1.x releases | Consumer guidance |
| --- | --- | --- |
| Core | Named ESM exports and TypeScript declarations from the package root `failtrace`, including documented option/result types | Import from `failtrace`. Files under `dist/core`, `src`, CLI and MCP implementation modules are internal; deep imports are not a supported API. |
| CLI | Documented command names, flags, units, defaults and [exit meanings](CLI.md#artifacts-and-exit-codes) | Use `--json` for automation. Human output, help layout, diagnostics, wording and timestamps are not parsing contracts. |
| JSON | Documented required fields, their types and meanings, status discriminants and any explicit `schemaVersion` | Accept additive optional fields. Dispatch on the operation and check its status; there is no universal result envelope or universal schema version. |
| MCP | The seven existing tool names, documented input schemas, structured result fields and evidence semantics | Read `structuredContent` and handle tool errors. The text content is the JSON serialization of the same data. Large lists may be projected; use complete counts, metadata paths and `failtrace_inspect_run`. |
| Saved run records | `loadRun` accepts supported storage schemas 1 and 2 within documented reader limits, returning a normalized schema-1 `RunSummary` | Pass a run ID, directory or `run.json`. Keep relative trial directories and logs together. Loading is read-only and never executes the recorded command. |
| Bundles | New bundles include their replay script, Core engine, reproduction config and content manifest | Keep the whole directory together. Run the included script with its matching config/engine; mixing versions or replacing its private engine modules is unsupported. |

The runtime floor is Node.js **22.12.0**. CI covers Node 22 and 24 on Windows, macOS and Linux, with an additional installed-package job pinned to Node 22.12.0 on Linux. Package smoke runs in a separate installed consumer. These checks do not guarantee every shell, filesystem, architecture or target dependency. Target commands retain platform shell syntax. FailTrace is local process orchestration, not a sandbox.

During 1.x, compatible optional fields, commands and tools may be added. Removing or renaming supported exports, required result fields, existing commands or tools, changing their meanings, or adding an incompatible status discriminant requires a major release or a separately opted-in versioned surface. A breaking storage writer must not silently replace a supported schema. Document deprecations in the changelog and retain the old supported surface until a major release.

Default changes that alter sampling, evidence interpretation or sharing behavior also require migration review. Safety fixes may reject malformed, redirected or unsafe inputs that previously slipped through; describe such changes explicitly. Resource limits are part of the documented behavior, not a promise to accept unlimited historical files. Do not equate patch compatibility with accepting corrupted evidence.

## Migration review for 1.1.0 Bisect safety changes

Version 1.1.0 rejects nonmatching nonzero exits as inconclusive by default. In 1.0.0, such an exit could become a negative predicate observation and advance `lastGood`, even when setup had prevented the test from running. Existing result statuses and saved run formats remain unchanged; the stricter candidate assessment and additive exit-policy/reason fields are intentional safety changes. This affects completion of searches that relied on that earlier interpretation.

If a completed, valid nonmatch intentionally exits with another code, explicitly supply `healthyExitCodes` / repeat `--healthy-exit-code`, including `0` if needed. Use `inconclusiveExitCodes` / `--inconclusive-exit-code` for known preparation failures that must never classify a commit. Do not allow a setup error merely to restore a green result. An unrelated error matching a broad predicate still requires a more specific predicate or an explicit inconclusive code. The old `assessRun` and regular run predicate contracts are unchanged; candidate health belongs to the Bisect result.

## Migration review for 1.1.0 comparison selection

Automatic comparison within one run now prefers a clean exit-0 nonmatch and a recorded target match. Previously the first non-passed trial could be a timeout even when a later trial matched the target. If no target match exists, the first failed outcome remains inspectable with an interpretation warning. Explicit trial indices and default first-trial selection between two runs are unchanged. Use explicit indices when reproducing an old comparison. Additive `selectedTrials` and `warnings` fields identify what was compared; a status of `passed` by itself is not semantic proof of successful test execution.

## Evidence formats at the 1.0 boundary

| Result or file | Version and interpretation |
| --- | --- |
| Core/CLI `RunSummary` | `schemaVersion: 1`, with a complete loaded trial array; incomplete status stays incomplete. |
| Stored `run.json` | Schema 1 embeds trials. Schema 2 uses `trialStorage: "individual"` and per-trial records; its embedded array can be empty. Use `loadRun` to reconstruct it. |
| Bisect result / `bisect.json` | Schema 2. Each candidate's `run` contains `trialCount`, `matchedTrials` and `metadataPath`; load the full run separately. |
| Minimization result | Schema 1. Check both `status` and `finalVerified`; `minimizedPath` can identify the best available input after an incomplete search. |
| Verify result | Schema 1. `target_observed`, `target_not_observed`, `inconclusive` and `interrupted` retain distinct meanings. |
| Bundle `repro.json` | Schema 2, paired with its included replay script; selected environment values and omitted-key prerequisites are separate. |
| Bundle `manifest.json` | Schema 1, relative file names, byte lengths and SHA-256 hashes at creation time. It excludes itself from its inventory and does not certify that content is safe to share. |
| Comparison, inspection and bundle-creation responses | Typed operation-specific objects without a top-level `schemaVersion`. Do not invent or require an absent version field. |

Schema numbers are local to each format. A schema-2 bisect result and a schema-2 stored run are different objects. MCP returns bounded projections where documented, so its displayed trial list is not necessarily the complete on-disk sample.

## Historical record support and its limits

The offline [released-producer fixtures](https://github.com/LBarimi/FailTrace/tree/main/tests/fixtures/released-runs) come from verified public 0.3.1, 0.4.0, 0.5.0 and 0.6.0 archives. They cover completed schema-1 records and actual unfinished schema-2 records from 0.4.0 onward. Tests exercise loading, comparison, saved inspection, incomplete-evidence rejection, eligible old-baseline verification and new bundle replay. Source hashes and output bytes are preserved; host paths and timings are replaced with disclosed placeholders.

This covers these formats and representative records, not every historical artifact. Files exceeding the [reader budgets](RESOURCE-LIMITS.md#metadata-and-scheduling), unsupported schemas, missing required completed records and redirected paths are rejected. Recovery can expose only durable records; it cannot recover a trial result never written to disk.

Missing old fields retain their meaning. An absent concurrency value means legacy sequential execution where the operation supports it. An absent output cap remains unknown in loaded evidence. Pre-0.5.0 records without captured context can still be compared and inspected but are not valid Verify baselines. Capture a fresh baseline instead of inventing context or treating missing data as a successful fix.

There is no general importer that migrates every old `bisect.json`, minimization report, Verify report or reproduction config. Read those as their declared version, follow their saved run references where available, or use the original package/bundle. Old self-contained bundles retain their original engine and behavior; installing a newer FailTrace does not upgrade them.

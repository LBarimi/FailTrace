# Changelog

## Unreleased

- Added opt-in `run --concurrency N` and the equivalent Core/MCP run option, keeping sequential execution as the default. Progress follows completion order with explicit trial indices; results remain index-sorted.
- Bisect/minimize use sequential threshold decisions to avoid unnecessary trials while retaining independent final minimization verification. Regular runs still attempt the full requested count.
- Run statistics update incrementally. Individual trial records are authoritative, run summaries are written initially and at finalization, and large summaries use compact storage reconstructed by `loadRun`.
- File-set minimization requests copy-on-write copies with ordinary-copy fallback. Bundles preserve run concurrency and replay the original full trial budget.
- Added reproducible performance benchmarks and guidance for external dependency caches. See `docs/PERFORMANCE.md` for measured scope, remaining costs, and deferred optimizations.

## 0.3.1 — 2026-09-05

- Installation guides use the public npm package for the demo, regular CLI use, and agent setup. The versioned GitHub archive remains an alternative.
- Added a reproducible historical Prettier case using pinned affected and fixed releases, a specific failure predicate, text minimization, and a replayable bundle. CI checks this workflow on Windows, macOS, and Linux with Node.js 22 and 24.
- Restricted packaged examples to the built-in demo files so locally installed case dependencies and investigation evidence cannot enter release archives. Installed-package checks enforce that boundary.
- Included MCP Registry identity and server metadata for discovery of the existing stdio tools.

The Core investigation behavior is unchanged; this patch updates distribution, documentation, and examples.

## 0.3.0 — 2026-09-04

First prebuilt GitHub release, focused on getting from installation to useful evidence.

- `failtrace demo` works from any directory. It measures a deterministic flaky command, reduces a JSON input to `["BUG"]`, and builds a replayable reproduction. Completed demos exit successfully while preserving their expected target failures as evidence.
- Packages include the compiled CLI/Core/MCP server, examples, and documentation. CI installs the actual packed artifact outside the source checkout and verifies public entry points, production dependencies, and the demo.
- MCP run results include `matchedTrials` across all recorded trials, including those omitted from compact responses. Server instructions explain how to choose and chain the existing investigation tools.
- README, Codex/Claude Code/Cursor setup guides, contributor guidance, and optional workflow-report forms focus on installation and real debugging use.
- The README preview is generated from a real demo result with `node scripts/render-demo.mjs`.

This release does not change the Core investigation algorithms. Regression conclusions remain sampled first-parent boundaries; minimization is local to supported removals; bundles require the target's own dependencies and setup.

## 0.2.0 — source implementation

Added failure predicates and comparisons, repeated-trial regression isolation, text/JSON/files/environment minimization, portable local reproduction bundles, and an official SDK stdio MCP adapter exposing five Core tools. Corrected bundle replay through filesystem aliases.

## 0.1.0 — source implementation

Implemented repeated command execution, failure statistics, timeout/interruption handling, inspectable artifacts, a deterministic flaky demo, and cross-platform CI.

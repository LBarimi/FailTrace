# Changelog

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

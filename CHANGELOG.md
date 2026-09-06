# Changelog

User-visible changes are listed here. [Compatibility](docs/COMPATIBILITY.md) covers integration contracts; [release validation](docs/RELEASE-VALIDATION.md) holds archive identities and installation checks.

## 1.4.0

- Add an optional read-only storage budget check: `artifacts --max-bytes N` and Core `inventoryArtifacts({ maxBytes })`. Complete checks distinguish within/over budget; partial scans remain inconclusive. No automatic deletion or write quota is introduced.
- Shorten the README, add task-based documentation navigation, and consolidate repeated setup and release information.
- Refresh the original demo animation and static alternatives from checked CLI results.
- Check installation versions, package/runtime/MCP metadata, demo asset identities, and local documentation links automatically.

Version 1.4.0 adds the storage budget option. Installation examples follow the verified public version declared in [Install](docs/INSTALL.md).

## 1.3.0

- Follow an exact NUnit 3 test and optional failure message through Core, CLI and MCP investigations, with a fresh report destination for every trial.
- Treat missing/skipped/ambiguous tests, unrelated failures and incomplete reports as inconclusive; Verify rereads the saved XML.
- Include an original EditMode example, a unit-test guide and offline NUnit bundle replay support.

## 1.2.0

- Add command-specific help; preserve literal `-h` and `--help` option values.
- Stream substring predicates and execution checkpoints during output capture; preserve inconclusive results for truncated or unsaved evidence.
- Bound regex worker reads and saved-output snapshots against growing or changing files.
- Bound saved metadata complexity and directory traversal, honor short reads and cancellation, and recompute statistics from saved trials.
- Reject JSON reductions that cannot preserve numeric values; retain incomplete evidence when candidate encoding exceeds its allowance.
- Add literal executable arguments across Core, CLI, MCP and replay, including complete-argument `{input}` binding.
- Add read-only artifact inventory with logical storage totals and known evidence references.
- Add execution checkpoints; Verify and replay require the recorded check to have completed.
- Add original data-import and asynchronous-update examples, workflow benchmarks, and independent integration-test cases.

## 1.1.0

- Prefer actual target matches over unrelated execution failures in automatic comparisons; expose selected-trial evidence and warnings.
- Require healthy nonmatches during Bisect; add explicit healthy/inconclusive exit policies. [Review the migration contract](docs/COMPATIBILITY.md) before upgrading custom nonzero-exit workflows.
- Improve Verify syntax errors, MCP setup guidance, the demo animation and optional workflow reporting.

## 1.0.0

- Establish the [1.x compatibility contract](docs/COMPATIBILITY.md), [0.x migration path](docs/MIGRATING-TO-1.md), and minimum Node.js 22.12.0 package gate.
- Bound output by default: 16 MiB per trial and 256 MiB per run or bisect/minimization. Truncated output cannot become healthy evidence.
- Bound metadata, input copies, JSON/directory complexity and scheduling; preserve incomplete investigations when limits are reached.
- Store compact schema-2 Bisect summaries. Load full candidate trials through `loadRun(candidate.run.metadataPath)`.
- Exclude original logs/metadata and captured environment values from bundles by default; require explicit selections and record replay prerequisites.
- Bound complete bundle copies to 512 MiB by default, add file/hash manifests, and retain self-contained replay behavior.
- Require a declared reason when Verify changes inherited output limits; support explicit migration of older baselines.
- Add offline saved-record compatibility fixtures and installed-package validation.

## 1.0.0-rc.1 — 2026-09-05

- Validate the 1.0 contract and resource controls in a public GitHub candidate. This candidate was not published to npm or the MCP Registry.

## 0.6.0 — 2026-09-05

- Extend the guided demo from repeated failure through reduction, baseline capture, unrelated-crash rejection, patch checking and replay.
- Add bounded read-only saved-trial and output inspection through Core and `failtrace_inspect_run`.
- Provide version-pinned MCP setup and installed-package checks for all seven tools.
- Record bounded benchmark samples and their interpretation limits.

## 0.5.0 — 2026-09-05

- Add Verify across Core, CLI and MCP with fixed-budget candidate trials and explicit observed/inconclusive outcomes.
- Capture source, input, setup and selected environment context before editing; require an explicit current command and working directory.
- Reject incomplete Git identity and unstable context; test that unrelated errors cannot become successful fix results.

## 0.4.0 — 2026-09-05

- Add optional run concurrency, keeping sequential execution as the default.
- Stop sequential Bisect/minimize classification when its threshold is decided; retain independent final reduction checks.
- Update statistics incrementally and reconstruct compact summaries from authoritative trial records.
- Introduce copy-on-write input copies with fallback (replaced by bounded copies in 1.0), replay settings, and reproducible benchmarks.

## 0.3.1 — 2026-09-05

- Document npm installation, restrict packaged examples to reviewed files, and include MCP Registry metadata.

## 0.3.0 — 2026-09-04

- Ship the prebuilt CLI, Core and MCP server with a guided demo that runs from any working directory.
- Validate installed artifacts outside the checkout; expose complete target-match counts to MCP clients.
- Generate the README preview from checked original demo results.

## 0.2.0 — source implementation

- Add failure predicates, comparison, repeated-trial Bisect, text/JSON/files/environment minimization, local replay bundles and a five-tool MCP adapter.
- Correct bundle replay through filesystem aliases.

## 0.1.0 — source implementation

- Add repeated execution, statistics, timeout/interruption handling, saved artifacts, a deterministic demo and cross-platform CI.

# Migrating from 0.x to 1.0

These changes are implemented in the source checkout toward 1.0 and are **not yet in the published 0.6.0 package**. Keep using an actually published version for pinned installs. This guide describes the migration to review before the stable release; it is not a publication announcement.

The core operations and seven MCP tools already exist. The 1.0 preparation changes bounded execution, result handling and bundle sharing rather than adding another debugging stage. See the [compatibility contract](COMPATIBILITY.md).

## Handle incomplete experiments explicitly

Commands now have finite output allowances: 16 MiB per trial and 256 MiB across an investigation by default. A trial that hits a cap retains its partial output and records `resource_limited` / `output_limit`. Output write failures record `output_error`. Neither outcome is a healthy predicate nonmatch. Run-level metadata exhaustion also preserves an explicit incomplete status and its recorded trials.

Core callers should check `status` or `assessRun`, and handle the additional trial/termination discriminants. CLI callers should preserve exit `2` as incomplete/invalid evidence. MCP callers should use structured status and complete counts rather than infer success from an empty displayed match list. Never interpret truncation or an unrelated crash as evidence that a fix worked.

If a legitimate command needs more retained output, set positive `maxOutputBytes` / `maxTotalOutputBytes` in Core or MCP, or `--max-output-bytes` / `--max-total-output-bytes` in the CLI. Zero does not disable limits. Investigations share the total output allowance across candidate runs.

Minimization also bounds input and retained copies; bundle creation bounds the complete bundle. Scheduling, metadata and input complexity have fixed ceilings. Text is limited to 1000000 Unicode code points, JSON to 100000 containers/values/keys, environment inputs to 10000 keys and directory traversal to 10000 entries including empty directories. Raising byte allowances does not remove these ceilings. See [resource limits](RESOURCE-LIMITS.md) for defaults, scopes and what those counters exclude. On minimization limits, preserve `minimizedPath` and inspect `status`, `storageLimit` or `metadataLimit`; do not describe the result as finally verified when `finalVerified` is false.

## Load bisect candidate trials through their reference

Bisect reports now use schema 2. They no longer duplicate every candidate's full trial array inside the parent report. Replace reads of `candidate.run.trials` with the public reader:

```ts
import { loadRun, type BisectCandidate } from 'failtrace';

async function matchingTrials(candidate: BisectCandidate) {
  const completeRun = await loadRun(candidate.run.metadataPath);
  return completeRun.trials.filter((trial) => trial.failureMatched === true);
}
```

Use `candidate.run.trialCount` and `candidate.run.matchedTrials` if counts are sufficient. MCP consumers can pass the saved run reference to `failtrace_inspect_run`. Keep the investigation directory and child run records together. This change does not rewrite existing reports or make old readers understand schema 2.

## Review old Verify baselines before executing candidates

Old recorded output limits are unknown. A context-enabled 0.5.0/0.6.0 baseline therefore needs an explicit `outputLimits` allowance when the candidate adopts finite caps:

```sh
failtrace verify <baseline-run-directory> --command "node reproduce.js" --cwd "/absolute/path/to/project" --allow-change "outputLimits:adopt finite output budgets" --json
```

Also declare any actual source, environment or other context changes with their reasons. The allowance documents a changed experiment; it does not establish equivalent conditions. An older baseline missing captured source/input/setup context is ineligible: reproduce and capture a new baseline before editing the code. Incomplete or threshold-stopped samples remain ineligible.

## Choose what a new bundle shares

New bundles exclude original run metadata/logs and captured environment values by default. They include selected source/input, the engine, replay files and `manifest.json`. Omitted captured environment keys become set/unset prerequisites, checked before replay executes the command.

- Review the relative file inventory and actual selected content before sharing.
- Use `--include-evidence` / `includeEvidence: true` only when you intend to copy unchanged original metadata and logs, including any values or paths they contain.
- Use repeated `--include-env KEY` / `includeEnv: ['KEY']` for selected captured values. Explicit `--env-file` / `env` overrides also opt values in. Otherwise supply the prerequisite keys in the recipient's environment.
- Choose a portable command and review source files too: defaults cannot remove a secret embedded in source, input or command text.

New `repro.json` files use schema 2. Existing bundles remain paired with their original replay scripts and included engines; keep those bundles intact. To adopt the new controls, create a fresh bundle from the saved run and review its manifest. A manifest hash describes creation-time bytes, not sanitization or the equivalence of environment values. See [bundle sharing and replay](BUNDLES.md).

## Before adopting the stable release

After its public version is available, install that exact package in a separate project, run the guided demo and replay its bundle. Check your own scripts against the new status handling and result shapes, then update pinned MCP clients together. Preserve old evidence while reviewing the migration. The [release process](RELEASING.md) requires cross-platform CI and the same verified archive on GitHub and npm before distribution is declared complete.

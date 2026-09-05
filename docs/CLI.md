# Command reference

This guide targets FailTrace 1.1.0. See the [installation instructions](../README.md#quick-start) for verified npm and GitHub package commands.

See the [README](../README.md) for installation and the guided demo, and [agent workflows](AGENT-WORKFLOWS.md) for client setup.

Concurrency, classification early stopping, and metadata reconstruction below require 0.4.0 or later. See [performance guidance](PERFORMANCE.md).

Verify and baseline context capture require version 0.5.0 or later.

Version 1.0 limits commands to 64 KiB UTF-8, `--repeat` to 100000, `--concurrency` to 64 and minimization `--max-evaluations` to 10000. It also bounds metadata creation and reconstruction. Metadata exhaustion preserves recorded trials and returns incomplete evidence with exit 2; see [resource scope](RESOURCE-LIMITS.md#metadata-and-scheduling).

Version 1.0 adds `--max-output-bytes` (16 MiB per trial) and `--max-total-output-bytes` (256 MiB across an investigation) to run, bisect, minimize and verify. These flags are not in published 0.6.0. Output exhaustion preserves partial evidence and is inconclusive, with CLI exit 2. Verify inherits the baseline caps; an override requires `--allow-change outputLimits:reason`. See [resource scopes and result semantics](RESOURCE-LIMITS.md).

## Repeat and identify a failure

```sh
failtrace run "<command>" [--repeat N] [--timeout DURATION] [--concurrency N]
failtrace run "npm test" --repeat 20 --stderr-contains "checkout failed"
failtrace run "npm test" --exit-code 7 --capture-env NODE_ENV,TZ --json
```

| Option | Meaning |
| --- | --- |
| `--repeat N` | Positive trial count; default `10` for run, `5` for bisect, `1` for minimize. |
| `--concurrency N` | Positive safe integer; maximum active trials, default `1` for `run`, inherited for `verify`. Bisect/minimize remain sequential. |
| `--timeout DURATION` | Per-trial timeout, default `30s`; supports `ms`, `s`, and `m`. |
| `--exit-code N` | Match exactly this exit code, including `0`. |
| `--stdout-contains TEXT`, `--stderr-contains TEXT` | Match a UTF-8 substring. |
| `--stdout-regex REGEX`, `--stderr-regex REGEX` | Match a JavaScript regex; optional `--regex-flags` supports `i`, `m`, `s`, `u`. |
| `--capture-env KEY1,KEY2` | On `run`, record only these selected environment values. |
| `--capture-context` | On `run`, capture bounded source identity before/after execution for later verification. |
| `--context-input FILE`, `--context-setup FILE`, `--context-source FILE` | Repeatable regular file paths relative to `cwd`; each implies context capture. Explicit source files select files-only scope; otherwise source identity uses Git. |
| `--cwd DIRECTORY` | Resolve working paths from this directory. |
| `--json` | Emit one JSON result on stdout with no terminal progress; supported on all investigation commands. |

Choose one predicate. The default matches non-zero exits. A trial that exits normally passes when the predicate does not match, even if a custom predicate ignores its non-zero exit. Timeouts, spawn failures, signals, and interrupted trials remain failed execution outcomes; they never establish that a specific target predicate matched. `Matched` reports actual predicate matches, while `Failed` includes execution failures.

`run` attempts all requested trials even after a match. `--concurrency 4` allows up to four active trials; omitting it preserves sequential execution. Trial indices and artifact paths remain stable. Terminal progress labels each trial and follows completion order; JSON results and loaded summaries sort trials by index. Core's `onTrialComplete` runs after each trial's metadata is durable, in completion order, and can return a promise. Concurrency may change failure probability through shared ports, databases, files, and resource contention. Choose it explicitly for targets whose overlap is meaningful; compare runs made with the same settings.

Substring checks stream output. Regex checks have a **16 MiB output limit** and a **one-second evaluation budget** in a worker; exceeding either produces an explicit investigation error. Use a substring for large logs.

Bare timeout numbers mean milliseconds. Fractional units such as `1.001s` are accepted when they resolve to whole milliseconds, up to `2147483647ms`. Options accept `--repeat=20` syntax. To match text beginning with `--`, use `--stderr-contains=--example`.

Quote the entire target command. The platform shell evaluates it in the selected directory: normally `cmd.exe` on Windows and `/bin/sh` on macOS/Linux. Inner quoting, shell operators, and variable syntax follow that shell. Put complicated commands in a script. Commands inherit your permissions and environment, receive no interactive stdin, and write stdout/stderr to artifact files.

Ctrl+C stops new trials, cleans up active process trees when possible, preserves metadata, and prints a partial summary. Statistics cover recorded trials, including interrupted active trials; unstarted trials are excluded. Durations include cleanup, so a timed-out trial can take slightly longer than its configured limit. Failure rate is an observed proportion, not a confidence estimate.

## Compare evidence

```sh
failtrace compare <run-id>
failtrace compare <run-a> <run-b> --trial-a 1 --trial-b 2
failtrace compare <run-id> --max-lines 100 --max-bytes 65536 --json
```

With one run, 1.1.0 prefers a clean exit-0 nonmatch and a recorded target match, so a preceding timeout does not hide the target. If no recorded match exists, failed execution evidence remains inspectable with a warning. With two runs, the first trial in each is still selected. Explicit trial indices override either selection. References can be a run ID, run directory, or `run.json` path. Version 1.0.0 selected the first passing and first failing trial within one run.

Version 1.1.0 adds `selectedTrials.a` / `.b` (status, exit code, termination reason, and predicate evidence when recorded), plus `warnings`. Read those fields before interpreting a diff. Aggregate `failureRate` includes infrastructure failures; it is not necessarily the target-match rate. An explicit nonzero nonmatching exit may be intentional or an unrelated failure; comparison does not decide which.

Results include aggregate failure-rate changes, command/predicate/concurrency changes, selected environment changes, stdout/stderr byte counts, full-stream SHA-256 hashes, and bounded line-aligned differences. A concurrency change identifies different experiment settings. Default limits are 200 displayed lines and a 64 KiB prefix per stream; truncation is explicit. This is an inspectable positional diff, not a semantic comparison or an optimal edit script. Matching hashes still compare the complete files.

After modifying code, use the [verification workflow](VERIFY.md). `compare` helps inspect outputs but does not validate the full experiment or produce a fix verdict. Older published packages can use the documented manual before/after procedure.

## Verify a proposed fix

This operation requires version 0.5.0 or later. Capture the baseline before editing the selected source, input or setup files:

```sh
failtrace run "node reproduce.js" --repeat 20 --stderr-contains "checkout failed" --context-input cases.json --context-setup package-lock.json --context-source reproduce.js --capture-env NODE_ENV,TZ --json
failtrace verify <baseline-run-directory> --command "node reproduce.js" --cwd . --allow-change "source:repair checkout handling" --json
```

Adapt project paths and replace the baseline placeholder with the returned artifact directory. The baseline run can exit `1`; do not chain these commands with `&&`. Verify requires explicit `--command` and `--cwd`, inherits the original predicate, selected file/environment declarations, repeat/timeout/concurrency settings, and rejects unsuitable baselines before target execution. Canonical working directories must match.

`--repeat N` preselects the full candidate count. `--timeout` and `--concurrency` can override inherited settings if the change is explicitly allowed. Repeat `--allow-change FIELD:REASON` for intended `command`, `source`, `inputs`, `setup`, `environment`, `timeout`, or `concurrency` interventions. A missing context, changed file during execution, timeout or unrelated unhealthy exit remains inconclusive. The default healthy nonmatch exit is `0`; repeat `--healthy-exit-code N` to replace that policy.

Inspect `status`, `baselineEligibility`, `reasons`, `changes`, `plan`, and both evidence references in the JSON. Complete trial counts are distinct from target matches and unhealthy executions. The durable report's `metadataPath` links all evidence. Exit `0` means `target_not_observed` in a healthy comparable sample, `1` means `target_observed`, and `2` means inconclusive/invalid. It never reports that a defect is eliminated or that its rate statistically improved. See [context scope, result semantics and limitations](VERIFY.md).

## Isolate a regression

**Since 1.1.0:** Bisect accepts `--healthy-exit-code N` and `--inconclusive-exit-code N` (both repeatable). A target nonmatch must exit `0` by default; an unrelated nonzero exit makes the candidate inconclusive. Supplying healthy codes replaces `[0]`. Explicit inconclusive codes stop the search even when the failure predicate matches. The two code lists cannot overlap. These options are absent from 1.0.0.

For a wrapper that exits `125` when preparation fails, use `--inconclusive-exit-code 125`. This is an explicit convention, not a reserved global exit code. A broad nonzero predicate alone cannot distinguish the target defect from a failed install. Target matches otherwise take precedence over healthy exits. No skipped-commit search or semantic proof that a test ran is implied. The report records both code lists and any candidate-specific `reason`; a candidate run's raw predicate `decision` must not override its health-aware `assessment`.

```sh
failtrace bisect --good v1.0.0 --bad HEAD --command "npm test" --repeat 10 --min-failures 3 --stderr-contains "checkout failed"
```

FailTrace verifies the good and bad endpoints, then searches **the bad revision's first-parent history** in a separate temporary Git worktree. It leaves the user's checkout and uncommitted changes in place. Each candidate uses repeated trials; `--min-failures` is the number of predicate matches required to classify it as reproducing.

Candidate trials remain sequential. `--repeat` is their maximum trial budget: evaluation stops when matches reach `--min-failures`, or when matches plus remaining trials cannot reach that threshold. A saved run's `decision` records the threshold, outcome, and completed trial count; `requestedTrials` retains the budget. Statistics describe only observed trials. They are classification evidence, not an unbiased full-budget failure-rate estimate. Execution errors, timeouts, and interruptions remain inconclusive. There is no bisect `--concurrency` option.

The search assumes a **monotonic sampled failure boundary** on that history. Repeated trials help measure flaky behavior but do not provide statistical confidence or detect every intermittent regression. Invalid endpoints, execution problems, or interruption produce an inconclusive/partial result instead of a claimed first bad commit.

Candidate runs and `bisect.json` remain under `.failtrace/bisects/<id>/`. Git worktrees do not include ignored dependencies or uncommitted source changes. Each candidate resets and cleans its temporary worktree, including ignored dependencies and build output. Include setup in the command as needed, and use an [external package-manager cache](PERFORMANCE.md#dependency-setup-during-bisect) to reuse downloads while preserving isolation. The temporary worktree is removed on clean completion, and cleanup errors are reported.

In version 1.0, bisect JSON uses `schemaVersion: 2`. Each `candidates[].run` contains `trialCount`, `matchedTrials` and `metadataPath`, replacing its embedded `trials` array. Core callers read full details with `await loadRun(candidate.run.metadataPath)`; MCP clients can pass that path to `failtrace_inspect_run`. Trial files and source provenance remain in the candidate run directory after worktree cleanup. This changes the parent bisect result shape; it does not change the stored run schemas.

## Minimize a reproduction

```sh
failtrace minimize --input examples/advanced-input.json --format json --command "node examples/advanced-demo.js" --stderr-contains "BUG reproduced"
```

This deterministic example reduces a six-element array to `["BUG"]`, preserving the original file. The command reads each candidate from `FAILTRACE_INPUT`. It reports a known message only for the intended failure, avoiding acceptance of unrelated syntax or setup errors.

| Format | Input and reduction behavior |
| --- | --- |
| `text` (default) | A UTF-8 file; remove lines, then Unicode characters. |
| `json` | A JSON file; remove array elements and object members recursively. Scalar values are retained. |
| `files` | A dedicated input directory; remove whole files and preserve relative paths. The command receives `FAILTRACE_INPUT_DIR`. |
| `env` | A JSON object of portable variable names and string values; remove selected variables from the target environment. Removed keys are explicitly unset. |

Reported units are Unicode characters, JSON tree nodes, files, or environment keys, respectively. Text, JSON, and environment candidates also expose `FAILTRACE_INPUT`. File-set commands must read the copied directory through `FAILTRACE_INPUT_DIR`, rather than the original input path. Other working-directory files and unselected environment variables remain available.

File-set copies request copy-on-write support when available and otherwise use ordinary copies. They do not use hard links; modifying a candidate cannot modify the original through a shared file link.

In version 1.0, `--max-input-bytes` bounds the original input and each candidate (16 MiB default), and `--max-candidate-bytes` bounds cumulative managed input copies (256 MiB default). Bounded streaming copies replace the published copy-on-write optimization. Storage exhaustion preserves an existing best available input, reports `limit_reached`, and leaves `finalVerified` false. See [input storage scope](RESOURCE-LIMITS.md#minimization-input-storage).

Use `--repeat N --min-failures K` to require repeated reproduction. The default evaluation budget is `--max-evaluations 200`, including baseline and final verification. Candidates are accepted only when the selected predicate still reproduces in clean trials. Original input, each candidate, its runs, the selected reduction, and `result.json` are retained under `.failtrace/minimizations/<id>/`.

Baseline, candidate, and independent final checks use the same sequential threshold early stopping described for bisect. The final check still runs as a separate evaluation. Each evaluation's `runDirectory` contains its observed trials and decision; do not interpret a short decided run as an interrupted run or its observed failure rate as a full-budget measurement. There is no minimize `--concurrency` option.

Check both `status` and `finalVerified`. A budget-limited result may still have a verified reduction; it does not mean the search finished. Completed reductions are local to the supported removal operations and the sampled outcomes, with no global-smallest guarantee. An explicit failure predicate is strongly recommended: a generic non-zero exit can match an unrelated failure introduced by reduction.

## Create a portable local bundle

Version 1.0 excludes original logs/metadata and captured environment values by default, adds `manifest.json`, and requires omitted captured environment keys before replay. Use `--include-evidence` for unchanged original evidence, repeat `--include-env KEY` for selected captured values, or supply reviewed values through `--env-file`. `--max-bundle-bytes` defaults to 512 MiB. Version 0.6.0 predates these changes; see [sharing choices, prerequisites and migration](BUNDLES.md).

```sh
failtrace bundle <run-id> --file examples/flaky-demo.js
failtrace bundle <final-run-directory> --file examples/advanced-demo.js --file examples/advanced-demo-implementation.js --file package.json --input <minimized-input-path>
```

For the second command, use the printed final run and minimized input paths, or `final.runDirectory` and `minimizedPath` from the JSON result. The bundle replays the final command with the minimized input.

```text
.failtrace/reproduction/<id>/
  README.md
  manifest.json Relative file inventory, byte lengths and creation-time hashes
  repro.json
  repro.mjs
  repro.sh
  repro.cmd
  engine/       Included compiled FailTrace Core and license
  source/       Explicitly selected source files
  input/        Optional selected input file or directory
  logs/         Original run evidence (only with --include-evidence)
```

Copy the directory to another location and run `node repro.mjs`, `sh repro.sh`, or `repro.cmd`. The included engine needs only Node.js; **install the target's own dependencies and external tools separately** as its bundle README explains. Replay runs from `source/`, restores the recorded predicate/requested count/timeout/concurrency, relocates the selected input, and saves new evidence under `replay-artifacts/`. It reports actual target-predicate matches, not arbitrary command errors. Replay executes the full requested count even for an early-stopped source run; exit `1` means at least one match, not that a previous classification's `minFailures` threshold was met.

Source files are opt-in through repeatable `--file` options and retain their paths relative to the original run's working directory. Selected paths must be regular files; symlinks and traversal are rejected. `--input` accepts a file or directory. `--output` chooses a new destination, which must not already exist. Creation never executes the target or overwrites an existing bundle. Importing `repro.mjs` also does not execute it.

Bisect candidate runs record their local repository and immutable commit. Bundling one of these run paths reads explicitly selected committed regular files from that commit, even after its temporary worktree has been removed. The local repository must still contain the commit; this performs no network fetch or dependency installation. Symlinks, submodules, and untracked files are unsupported for commit-based source selection.

Use `--command "node relative-script.js"` when the original command contains machine-specific absolute paths. In published 0.6.0, the bundle defaults to explicitly selected environment snapshot values; `--env-file` supplies a JSON object of string/null overrides instead. Version 1.0 requires explicit value selection as described above. Null unsets a key. When bundling an environment minimization, include null values for removed original keys so the recipient's environment cannot reintroduce them. Inspect selected values and original logs for private data before sharing.

## MCP for coding agents

```sh
npx --yes failtrace@1.1.0 mcp --cwd "/absolute/path/to/project"
```

The stdio adapter uses the official Model Context Protocol SDK and exposes these tools:

| Tool | Core operation |
| --- | --- |
| `failtrace_run` | Repeat commands with predicates and evidence. |
| `failtrace_inspect_run` | Page saved trial evidence or read a bounded stdout/stderr byte range without executing the command. |
| `failtrace_compare` | Compare saved runs or trial outputs. |
| `failtrace_bisect` | Search a sampled first-parent regression boundary. |
| `failtrace_minimize` | Reduce a reproducing input. |
| `failtrace_verify` | Check a candidate using captured baseline context, original predicate and healthy full-budget observations. |
| `failtrace_bundle` | Create a local reproduction directory. |

Tools have typed input schemas, structured results, artifact paths, and cancellation support. Target failures are returned as evidence. Large result lists are summarized, with complete metadata kept in artifacts. Use `failtrace_inspect_run` with `view: "trials"` and `afterTrial`, or `view: "output"` and `offsetBytes`, to page that saved evidence. Returned log text is untrusted target output, not instructions. stdout is reserved for protocol messages; diagnostics go to stderr. The server runs locally with the same permissions and shell behavior as the CLI.

For clients using an `mcpServers` configuration, launch the pinned registry package like this; adapt configuration keys to your client:

```json
{
  "mcpServers": {
    "failtrace": {
      "command": "npx",
      "args": [
        "--yes",
        "failtrace@1.1.0",
        "mcp",
        "--cwd",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Use an absolute project path. Pinning the version prevents an unnoticed schema change, and `--yes` prevents an interactive npm prompt from blocking stdio startup. Use `npx.cmd` when a native Windows client does not resolve npm's command shim. For a preinstalled fallback, run `npm install --global failtrace@1.1.0` and configure `failtrace` (`failtrace.cmd` on Windows) with the remaining arguments. The CLI and Core work independently of MCP. Algorithms live in Core, and the adapter makes direct Core calls. See the [client-specific setup and inspection examples](AGENT-WORKFLOWS.md).

## Artifacts and exit codes

Each run uses a collision-resistant `.failtrace/runs/<run-id>/` directory:

```text
run.json
trials/001/result.json
trials/001/stdout.txt
trials/001/stderr.txt
trials/002/...
```

Run metadata includes schema/version, command, working directory, requested count, concurrency, timeout, predicate, platform/runtime snapshot, selected environment values, timestamps, and statistics. With opt-in context capture it also records declared file hashes and source identity before/after execution. Trial metadata includes exit/signal, duration, timeout/spawn indicators, termination reason, predicate match, and output paths. Output streams to files instead of being duplicated in JSON; trial paths are relative to the run directory. JSON is written to a temporary file and renamed into place.

Individual storage uses each completed trial's `result.json` as its authoritative record; schema-1 storage reads the trials embedded in its header. `run.json` is written initially and at finalization rather than rewritten after every trial. A running snapshot or a large final summary uses on-disk `schemaVersion: 2`, `trialStorage: "individual"`, and an empty embedded trial array. Completed/interrupted compact summaries record `trialCount`, and loading requires that exact number of records. Compact error summaries omit this count because a failed write may have left fewer durable records; loading recovers those records while preserving the error status. Use the public `loadRun(reference)` API, also used by compare/bundle, to reconstruct index-sorted evidence from individual results. It accepts storage versions 1 and 2 and returns the existing schema-1 in-memory summary. Versions before 0.4.0 cannot read compact storage. Raw `run.json` alone may show stale progress after a process crash; reconstruction cannot recover a trial result that was never durably written.

Small final summaries retain storage schema 1 and embedded trials for compatibility. At 1 MiB, new final summaries switch to individual storage before reaching the 32 MiB per-document reader limit. Version 1.0 additionally bounds aggregate reconstruction and writes schema-2 `bisect.json` reports with compact candidate descriptors; use `loadRun(candidate.run.metadataPath)` for their individual trials. Published 0.6.0 still embeds candidate summaries and does not cap output files or retained candidates. See the [new resource limits](RESOURCE-LIMITS.md), [compatibility contract](COMPATIBILITY.md) and [0.x migration](MIGRATING-TO-1.md).

`.failtrace/` is ignored by this repository; configure your own repository accordingly. Saved artifacts can be removed when their investigations are inactive. Resource counters do not impose a total filesystem quota or automatic retention policy.

| Exit code | Meaning |
| --- | --- |
| `0` | A run has no failed outcomes; comparison/bundle succeeded; bisect found a boundary; minimization completed and passed final verification; or Verify returned healthy `target_not_observed` evidence. |
| `1` | `run` recorded a failed trial, or Verify returned `target_observed`. Bundle replay uses `1` when the target predicate reproduces. |
| `2` | Invalid usage, an internal error, or an inconclusive/incomplete investigation, including evaluation limits. |
| `130`, `143` | Interrupted by SIGINT/Ctrl+C or SIGTERM. |

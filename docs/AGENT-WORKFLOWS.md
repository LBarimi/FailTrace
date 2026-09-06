# Use FailTrace with a coding agent

**NUnit integration in 1.3.0:** [NUnit and Unity unit tests](UNIT-TESTS.md) use existing MCP tools with `predicate.kind: "nunit_test"`, a fresh `{testReport}` destination and structured `trial.unitTest` evidence. The guide covers baseline capture, patch verification and missing/skipped tests. Version 1.2.0 does not provide this predicate; see the README for publication status.

This guide targets published FailTrace 1.3.0. Version 1.2.0 adds [execution checkpoints](EXECUTION-EVIDENCE.md); use a supporting version throughout that workflow. See the [installation instructions](../README.md#quick-start) for verified npm and GitHub package commands.

Ask your agent to measure a flaky command, compare the saved evidence, or reduce a reproducing input. FailTrace performs the repeated experiments locally and returns inspectable results; the agent uses those results to investigate the code.

> Use FailTrace to run `npm test -- checkout` 20 times with a 30-second timeout. Match the known stderr message `checkout failed`. Report actual predicate matches separately from timeouts or command setup errors, then compare one clean passing trial with one matching trial. Use the returned artifact paths.

Install FailTrace from the npm registry, connect the local server, and try an experiment in any project. No source checkout or build is needed for this path. Installing the server makes its tools available; choosing a tool remains the agent's decision. The optional project instructions below help it recognize suitable tasks.

## Start the local server

With Node.js **22.12 or newer**, no checkout or global install is required:

```sh
npx --yes failtrace@1.3.0 mcp --cwd "/absolute/path/to/project"
```

Replace the project path with an absolute path. Relative paths can resolve from a client-specific launch directory. Pinning `1.3.0` keeps tool names and schemas stable across reconnects. `--yes` accepts npm's first-use package installation without an interactive prompt that could block the MCP handshake; see the [official npm `npx` command reference](https://docs.npmjs.com/cli/v12/commands/npx/). FailTrace reserves stdout for protocol messages; npm notices and server diagnostics use stderr, while target-command stdout/stderr is written into run evidence.

The client starts and owns this stdio process. Running it directly in a terminal waits for MCP requests; it is not an interactive prompt.

### Global-install fallback

If repeated `npx` startup or registry access is unsuitable, install the same exact version once:

```sh
npm install --global failtrace@1.3.0
failtrace mcp --cwd "/absolute/path/to/project"
```

Use `failtrace` as the configured command and `mcp`, `--cwd`, and the absolute project path as its arguments. Native Windows clients that do not resolve npm's command shims should use `failtrace.cmd`; the same rule uses `npx.cmd` for the no-install examples below.

## MCP client configuration and Windows paths

Clients that accept `mcpServers` JSON can use this configuration shape with their own configuration location. Every `args` element is one argument; do not add shell quotes inside an argument string.

```json
{
  "mcpServers": {
    "failtrace": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "failtrace@1.3.0",
        "mcp",
        "--cwd",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Use `npx.cmd` on Windows when the client launches commands directly rather than through a shell. JSON backslashes must be doubled; forward slashes make Windows project paths easier to copy. Use `run`, `compare`, `bisect`, `minimize`, `verify`, or `bundle` for terminal investigations.

### Source fallback and contributor setup

For an original investigation against the source build, try the [data-import and asynchronous-update workflows](WORKFLOWS.md). Their completed-check requirement needs version 1.2.0 or newer.

To build from source instead, clone the repository, run `npm ci` and `npm run build`, then configure `node` with the checkout's absolute `dist/cli/index.js`, `mcp`, `--cwd`, and absolute project path as separate arguments. Keep the checkout and rebuild after updates. The advanced source-demo recipe later in this guide uses a checkout; the connection test does not.

## Confirm the connection with a real experiment

This connection check works in **any existing working directory**. It needs only Node.js on the target command's `PATH`; it reads no project fixture files.

Ask the agent:

> List the available FailTrace tools, then run the inline Node experiment below with `failtrace_run`. Use five trials and a 5-second timeout. The fifth trial prints `FAILTRACE_DEMO` on stderr and exits with code 7. Report the actual `matchedTrials`, pass/fail counts, and artifact directory; inspect the matching trial's stderr before calling the setup successful.

Version 1.1.0 exposes seven tools: `failtrace_run`, `failtrace_compare`, `failtrace_bisect`, `failtrace_minimize`, `failtrace_verify`, `failtrace_bundle`, and `failtrace_inspect_run`. A client may add a server prefix to their displayed names.

`failtrace_verify` and `captureContext` on `failtrace_run` require version 0.5.0 or later. List the installed server's tools before assuming the selected package provides them.

Version 0.4.0 adds optional `concurrency` to `failtrace_run`; it defaults to `1` and is not accepted by bisect/minimize. Overlapping commands can change failure probability through shared resources. Returned trials stay sorted by index. Versions through 0.3.1 predate this option; see [performance guidance](PERFORMANCE.md).

The `failtrace_run` arguments are:

```json
{
  "command": "node -e \"if(process.env.FAILTRACE_TRIAL_INDEX==='5'){console.error('FAILTRACE_DEMO');process.exitCode=7}\"",
  "repeat": 5,
  "timeoutMs": 5000,
  "predicate": {
    "kind": "stderr_contains",
    "value": "FAILTRACE_DEMO"
  }
}
```

Expected results are **four passes, one target failure, `matchedTrials: 1`**, and a failure rate of `0.2`, or **20.0%**. The command's quoting works through the platform shell on Windows, macOS, and Linux. JSON escapes the inner double quotes; pass the decoded `command` string to the tool without adding another quoting layer.

For a basic terminal installation check in any project:

```sh
failtrace run "node --version" --repeat 5 --timeout 5s --json
```

That command should report five passes and exit `0`. In investigations that record failed outcomes, the `run` CLI exits `1` while preserving the JSON evidence; this is not a reason to rerun the same experiment indefinitely.

## Choose a workflow from the problem

| Situation | Tool and result to inspect |
| --- | --- |
| A command sometimes fails | `failtrace_run`: trial outcomes, `failureMatched`, statistics, and artifact paths. |
| Passing and failing logs need comparison | `failtrace_compare`: selected trial indices, stream hashes, bounded diffs, and truncation. |
| A summarized run needs complete trial or log evidence | `failtrace_inspect_run`: filtered trial pages and bounded stdout/stderr byte ranges, without command execution. |
| A known good revision became bad | `failtrace_bisect`: verified endpoint assessments, `status`, `firstBad`, and cleanup diagnostics. |
| An input reproduces but is too large | `failtrace_minimize`: accepted candidates, `status`, `finalVerified`, and `minimizedPath`. |
| Code was changed and the original failure needs rechecking | `failtrace_verify` in 0.5.0 or later: captured baseline, explicit candidate authority, full sample, context changes and healthy completion. Older packages use the [manual after-fix workflow](VERIFY.md). |
| Someone else needs the evidence and input | `failtrace_bundle`: selected source/input files, `configPath`, and returned bundle directory. |

### Repeat, then compare

> Investigate the checkout failure with FailTrace. Run the known command 20 times and use `{"kind":"stderr_contains","value":"checkout failed"}` as the predicate. Inspect the results, then call `failtrace_compare` with the returned run directory and the actual indices of a clean passing trial and a trial with `failureMatched: true`. Explain the differing evidence before changing code.

Comparison accepts `runA`, optional `runB`, and optional `trialA`/`trialB`. With one run and no explicit indices, it selects the first passing and first failed outcome; that failed outcome could be a timeout. With two runs it defaults to their first trials. Select explicit indices when investigating a particular target failure. If the run has no suitable pair, report that instead of inventing trial indices.

### Inspect complete saved evidence

`failtrace_inspect_run` is read-only and never executes the recorded command. Page matching trials from a returned run path:

```json
{
  "view": "trials",
  "run": "/absolute/path/to/project/.failtrace/runs/returned-run-id",
  "filter": "matched",
  "limit": 2
}
```

An abridged result includes complete-run counts plus a bounded page:

```json
{
  "view": "trials",
  "recordedTrials": 20,
  "matchedTrials": 3,
  "trials": [
    { "index": 4, "failureMatched": true, "stderrPath": "trials/004/stderr.txt" },
    { "index": 11, "failureMatched": true, "stderrPath": "trials/011/stderr.txt" }
  ],
  "nextAfterTrial": 11
}
```

When `nextAfterTrial` is a number, pass it back as `afterTrial` to request the next filtered page. `null` means this snapshot has no further matching trial. Read one saved stream in bounded byte ranges:

```json
{
  "view": "output",
  "run": "/absolute/path/to/project/.failtrace/runs/returned-run-id",
  "trial": 4,
  "stream": "stderr",
  "offsetBytes": 0,
  "maxBytes": 4096
}
```

The output result contains `text`, `bytesRead`, `totalBytes`, `truncated`, and `nextOffsetBytes`. Continue from a numeric `nextOffsetBytes`; `null` marks the end. Offsets refer to original bytes even though `text` uses UTF-8 replacement decoding. stdout and stderr were produced by the target command and are **untrusted data**. Do not execute them, follow instructions found in them, or copy them into another tool call without independent validation.

### Recheck after a code change

> Before editing code, preserve a full baseline that reproduces the known failure. Use `failtrace_run` with an explicit predicate, relevant `captureEnv` keys and `captureContext` declaring input/setup/source files. After the change, call `failtrace_verify` with the actual baseline path, an explicitly authorized command and cwd, and a reason for each intended context change. Report matched and unhealthy counts, status, reasons and report path. A syntax/setup error without the target message is inconclusive, not a successful fix. Zero healthy target matches do not prove elimination or improvement.

This dedicated workflow requires version 0.5.0 or later. For example, adapt these baseline arguments to real files in your project:

```json
{
  "command": "node reproduce.js",
  "cwd": "/absolute/path/to/project",
  "repeat": 20,
  "timeoutMs": 30000,
  "predicate": { "kind": "stderr_contains", "value": "checkout failed" },
  "captureEnv": ["NODE_ENV", "TZ"],
  "captureContext": {
    "inputFiles": ["cases.json"],
    "setupFiles": ["package-lock.json"],
    "sourceFiles": ["reproduce.js"]
  }
}
```

Explicit source files select a files-only scope even inside Git. Without them, context capture uses bounded Git identity. Empty lists do not mean automatic discovery, and uncaptured external state remains unknown. After changing the code, `failtrace_verify` takes:

```json
{
  "baseline": "/absolute/path/to/returned/baseline-run",
  "command": "node reproduce.js",
  "cwd": "/absolute/path/to/project",
  "allowChanges": [{ "field": "source", "reason": "repair checkout handling" }]
}
```

Use the actual returned baseline path, not the illustrative one above. Verify inherits the baseline predicate, file declarations, captured environment keys and sampling defaults; it requires the same canonical working directory. Optional `repeat` sets a prechosen full candidate budget, with no threshold stopping. Optional `healthyExitCodes` replaces `[0]` for nonmatching trials; optional `env` is a string/null override dictionary, with null unsetting a variable. Declare changed `command`, `source`, `inputs`, `setup`, `environment`, `timeout` or `concurrency` with reasons in `allowChanges`; missing/unstable evidence cannot be excused this way.

Read the operation's `status` even when MCP `isError` is false. `target_observed` records a remaining target, `target_not_observed` requires healthy comparable complete evidence, and `inconclusive`/`interrupted` cannot support an absence claim. Counts cover all trials. Context summaries give file counts and source identity; complete hashes and before/after changes are at the returned `metadataPath`. The report also links baseline/candidate run metadata for full trial inspection.

For versions through 0.4.0, use two full `failtrace_run` samples and `failtrace_compare`, performing these checks yourself. Minimization's `finalVerified` verifies that a reduction still fails, not that a code change fixes it. See the [verification procedure and limits](VERIFY.md).

### Minimize, then bundle

**Optional source example:** this recipe uses files shipped in the FailTrace source checkout. Set the tool's `cwd` to that checkout, or adapt the command and input to a reproduction in your own repository. It is not required for installation or the connection check above.

> Use `failtrace_minimize` to reduce `examples/advanced-input.json` as JSON. Run `node examples/advanced-demo.js`, match stderr containing `BUG reproduced`, use a 5-second per-trial timeout, and allow at most 40 evaluations. Preserve the source input. Check both status and final verification, then show the actual minimized contents and final run directory.

The corresponding minimization arguments are:

```json
{
  "command": "node examples/advanced-demo.js",
  "input": "examples/advanced-input.json",
  "format": "json",
  "timeoutMs": 5000,
  "maxEvaluations": 40,
  "predicate": {
    "kind": "stderr_contains",
    "value": "BUG reproduced"
  }
}
```

The shipped demo can reduce to `["BUG"]`. Use the observed `minimizedPath` and `final.runDirectory` for the next step; evaluation IDs and artifact directories change on every invocation.

> If final verification reproduced the intended failure, create a local bundle from the returned `final.runDirectory`, selecting `examples/advanced-demo.js`, `examples/advanced-demo-implementation.js`, and `package.json` as source files and the returned `minimizedPath` as input. Use `failtrace_bundle`; inspect its `repro.json`. Then run `node repro.mjs` from the returned bundle directory and report the actual predicate matches. Creating the bundle alone does not verify replay.

The bundle tool takes `run`, `files`, and `input` for this workflow. `files` is an array of paths relative to the original run's working directory. `input` is the returned input path. Other optional fields are `cwd`, `command`, `env`, and `destination`; the destination must be new. Do not substitute made-up run IDs into a follow-up call.

Version 1.0 adds `includeEvidence`, `includeEnv` and `maxBundleBytes`. Original metadata/logs and captured values are excluded by default. Review the returned `manifestPath`, `environmentKeys` and `requiredEnvironment` before sharing or replaying. Select original evidence or captured values explicitly when needed; including original evidence also includes any private values already in those records. Missing environment prerequisites stop replay before target execution. Version 0.6.0 predates these controls; see [bundle sharing and migration](BUNDLES.md).

For your own minimization command, read candidate files through `FAILTRACE_INPUT`, or file sets through `FAILTRACE_INPUT_DIR`. A command that keeps reading the original input cannot measure the proposed reductions. For environment minimization, bundle environment overrides should include `null` for every removed original key, so inherited values cannot restore it during replay.

### Isolate a revision boundary

> The failure is absent at the verified good revision and present at the verified bad revision. Use `failtrace_bisect` with those exact refs, the reproducing command, five trials per candidate, and a threshold of three target-predicate matches. Inspect endpoint validation and every inconclusive result. Claim a sampled boundary only when `status` is `found`, and report the first-parent/monotonicity assumption and any cleanup error.

Provide `good`, `bad`, `command`, `repeat`, and `minFailures`, plus an explicit `predicate` when available. Git is required. Ignored dependencies are absent from the isolated worktree, so account for the target's setup before launching a lengthy investigation. Preserve reset/clean isolation and keep any package-manager download cache outside the temporary worktree; see the [cache guide](PERFORMANCE.md#dependency-setup-during-bisect).

In 0.4.0 and later, bisect/minimize trials remain sequential but stop once matches reach `minFailures`, or matches plus remaining trials cannot reach it. `repeat` is the maximum budget for each baseline/candidate/final check. A decided run can contain fewer trials without being interrupted. Check its `decision` and the operation's assessment; the observed rate is not an unbiased estimate from the full budget. Minimization still executes an independent final check.

## Read tool results correctly

MCP calls return an envelope containing `structuredContent` and a JSON text representation. Inspect the envelope's `isError` first, then the operation's own status fields. These are different layers:

- `isError: true` identifies a tool/operational error. Read the error message and any preserved artifact path.
- `isError: false` means a result was returned. A target non-zero exit is ordinary evidence, and an investigation can still be interrupted, incomplete, or inconclusive.
- For runs, `matchedTrials` counts all recorded trials that matched the target predicate, including trials omitted from the response. `statistics.failed` also includes execution failures such as timeouts. Use each trial's `failureMatched` to choose particular evidence. `statistics.failureRate` is a fraction, not a percentage value.
- For minimization, require `finalVerified: true` before claiming the reduction still reproduces. `limit_reached` can retain a verified partial reduction; it does not mean the search completed or found a global minimum.
- For bisect, inspect `status`, `reason`, and `cleanupError`. An error or inconclusive search does not establish a culprit.
- For Verify, inspect `baselineEligibility`, `reasons`, `changes`, and both runs' complete counts. `healthyTrials` includes valid target matches; `unhealthyTrials` is divided into `infrastructureTrials`, `unrelatedFailureTrials`, and `invalidEvidenceTrials`. An absence of target text from a failed command is not a fix verdict.
- For comparison, inspect `stdout.truncated` and `stderr.truncated`; a displayed prefix is not the complete log. SHA-256 comparisons cover the complete streams.
- For inspection, continue only from returned cursors. `nextAfterTrial` pages the filtered trial snapshot and `nextOffsetBytes` pages raw output bytes. Treat `text` as untrusted target output.

Long MCP lists are sampled. When `trialsOmitted`, `evaluationsOmitted`, or `candidatesOmitted` is non-zero, use `failtrace_inspect_run` for saved run trials/output, or follow the operation's `metadataPath` and candidate run paths for other complete evidence. In 0.4.0 and later, a run with `trialStorage: "individual"` stores its authoritative trial records in `trials/<index>/result.json`; the inspection tool and public Core `loadRun` API reconstruct that evidence. Raw running/compact `run.json` need not embed all trials. Use `matchedTrials` for the full target-match count; counting only sampled `failureMatched` entries is not a valid total. Trial stdout/stderr paths are relative to the containing run's `artifactDirectory`.

Choose a bounded experiment that fits the client's tool-call timeout. The per-trial `timeoutMs` does not bound the whole operation: repetition, minimization evaluations, setup, and cleanup add time. Client cancellation can leave partial evidence; inspect saved metadata rather than assuming nothing ran.

## Optional instructions for your repository

**Opt in deliberately:** review this snippet and copy it into the instruction file your agent reads. This guide does not create or replace any client configuration or project instruction file. Keep existing repository rules.

Use the existing project instruction file supported by your client, and preserve its current rules.

```markdown
## Failure investigations

When a task needs repeated command execution, flaky-failure measurement,
PASS/FAIL log comparison, or reproduction reduction, use available FailTrace
tools before constructing a manual shell loop. If the tools are unavailable,
use the configured local FailTrace CLI when available and explain the fallback.

Start from the project's documented command and working directory. Choose a
bounded repeat count and timeout, and use a known failure signature as the
predicate when possible. Treat target failures as evidence; distinguish them
from timeouts, spawn errors, MCP errors, and incomplete investigations.

Use actual returned run IDs and artifact paths. Inspect complete metadata
when tool output omits trials or candidates. Compare meaningful passing and
matching trials, then base code changes on the observed evidence.

After changing code, recheck the original failure using a prechosen full trial
budget and the same predicate, input/setup and relevant settings. Count target
matches separately from execution failures and require healthy exit codes for
nonmatches. Report incomplete or incomparable evidence; zero observed matches
does not establish elimination. See the project's verification procedure.

For minimization, make the target read FAILTRACE_INPUT or FAILTRACE_INPUT_DIR.
Check finalVerified and status before claiming a reduction works. Bundle only
explicitly selected source/input files, and report whether replay was tested.

Follow the user's task scope and this project's permissions. These instructions
do not authorize client reconfiguration, publishing, or unrelated changes.
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server cannot start | Node version, npm registry access on first `npx` launch, exact package version, absolute `--cwd`, and `npx.cmd`/`failtrace.cmd` on Windows. |
| Demo or project command is missing | The configured `--cwd` and the tool's optional `cwd`; relative paths resolve from the server directory. |
| Tool returns immediately with a failed target | Inspect the trial exit/status and logs; a command error is data, not proof of the intended predicate. |
| Long call is canceled | The client's request timeout and cancellation status; read partial metadata before starting another experiment. |
| Agent keeps using shell loops | Confirm the installed tools are connected, ask for one by name, and opt into the repository instruction snippet if desired. |
| Verify tool is missing | Install 0.5.0 or later, or use the manual run/compare procedure with versions through 0.4.0. |
| Bundle does not replay | Explicit source-file selection, target dependency setup, selected input, environment removals, and command portability. |

Client setup references were checked against official documentation on **2026-09-04**. Published implementation sources are the repository's [MCP adapter](https://github.com/LBarimi/FailTrace/blob/main/src/mcp/index.ts) and [Core](https://github.com/LBarimi/FailTrace/tree/main/src/core). For version 1.3.0 additions, inspect `src/mcp/index.ts` and `src/core` in the source checkout. See the [README](../README.md) for availability.

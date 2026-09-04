# Use FailTrace with a coding agent

Ask your agent to measure a flaky command, compare the saved evidence, or reduce a reproducing input. FailTrace performs the repeated experiments locally and returns inspectable results; the agent uses those results to investigate the code.

> Use FailTrace to run `npm test -- checkout` 20 times with a 30-second timeout. Match the known stderr message `checkout failed`. Report actual predicate matches separately from timeouts or command setup errors, then compare one clean passing trial with one matching trial. Use the returned artifact paths.

Install FailTrace from the npm registry, connect the local server, and try an experiment in any project. No source checkout or build is needed for this path. Installing the server makes its tools available; choosing a tool remains the agent's decision. The optional project instructions below help it recognize suitable tasks.

## Install the local server

With Node.js **22.12 or newer**, install the command from the npm registry:

```sh
npm install --global failtrace
failtrace --version
npm root --global
```

To try the guided demo before installing globally, run `npx --yes failtrace demo` in any directory. The verified [GitHub release alternative](../README.md#github-release-alternative) is also available.

Append `/failtrace/dist/cli/index.js` to the directory printed by `npm root --global`. That is your **server entry point**. For example, a Windows npm root of `C:\Users\you\AppData\Roaming\npm\node_modules` gives `C:/Users/you/AppData/Roaming/npm/node_modules/failtrace/dist/cli/index.js`.

In every client example below, replace `/absolute/path/to/failtrace/dist/cli/index.js` with **that exact entry point**, and `/absolute/path/to/project` with the repository you want to investigate. Windows example paths are illustrative too; use your actual npm root. The installed command starts the same server:

```sh
failtrace mcp --cwd "/absolute/path/to/project"
```

For client configuration, the explicit Node/script examples below also avoid differences in how native Windows clients launch npm command shims.

### Source fallback and contributor setup

To build from source instead:

```sh
git clone https://github.com/LBarimi/FailTrace.git
cd FailTrace
npm install
npm run build
node dist/cli/index.js --version
```

Use this checkout's absolute `dist/cli/index.js` path as the same server entry point. Keep the checkout and rebuild after updates. `npm link` is optional if you also want the `failtrace` terminal command. The advanced source-demo recipe later in this guide uses this checkout; the connection test does not.

## Codex

Register the installed server with the Codex CLI:

```sh
codex mcp add failtrace -- node "/absolute/path/to/failtrace/dist/cli/index.js" mcp --cwd "/absolute/path/to/project"
codex mcp list
```

For a longer but bounded investigation, edit the existing server table in `~/.codex/config.toml`, or use a project `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.failtrace]
command = "node"
args = ["/absolute/path/to/failtrace/dist/cli/index.js", "mcp", "--cwd", "/absolute/path/to/project"]
cwd = "/absolute/path/to/project"
startup_timeout_sec = 10
tool_timeout_sec = 600
```

Replace paths with your own; Windows TOML strings can use forward slashes. The default tool timeout is 60 seconds. This example allows ten minutes, so still choose counts and per-trial timeouts that leave room for setup and cleanup. Start with five trials at `timeoutMs: 5000` when checking a new connection. The configuration fields, scopes, defaults, and CLI registration follow [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Claude Code

From the project you want to investigate, register the server. Replace both absolute paths:

```sh
claude mcp add --transport stdio --scope local failtrace -- node "/absolute/path/to/failtrace/dist/cli/index.js" mcp --cwd "/absolute/path/to/project"
claude mcp get failtrace
```

For native Windows PowerShell, the same single-line command can use forward-slash paths:

```powershell
claude mcp add --transport stdio --scope local failtrace -- node "C:/Users/you/AppData/Roaming/npm/node_modules/failtrace/dist/cli/index.js" mcp --cwd "C:/work/my project"
```

Local scope keeps this registration private to the current project. Project scope instead writes a shareable `.mcp.json`; review machine-specific paths before choosing that scope. In Claude Code, use `/mcp` to check the connection and available tools. Follow the client's normal server approval flow if it requests one. These registration and scope details follow the [official Claude Code MCP reference](https://code.claude.com/docs/en/mcp).

## Cursor

For a project configuration, merge this entry into that project's `.cursor/mcp.json`. Set the server entry point found above; `${workspaceFolder}` selects the project containing the configuration:

```json
{
  "mcpServers": {
    "failtrace": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/failtrace/dist/cli/index.js",
        "mcp",
        "--cwd",
        "${workspaceFolder}"
      ]
    }
  }
}
```

Cursor also supports a global `~/.cursor/mcp.json`. For a configuration tied to one project, the project file keeps the working directory explicit. Check the server in Cursor's Customize page and confirm the five tools are available to Agent. Cursor's configuration locations, `stdio` fields, and workspace interpolation are documented in its [official MCP reference](https://cursor.com/docs/mcp).

## Other clients and Windows paths

Clients that accept `mcpServers` JSON can use this configuration shape with their own configuration location. Every `args` element is one argument; do not add shell quotes inside an argument string.

```json
{
  "mcpServers": {
    "failtrace": {
      "type": "stdio",
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/Users/you/AppData/Roaming/npm/node_modules/failtrace/dist/cli/index.js",
        "mcp",
        "--cwd",
        "C:/work/my project"
      ]
    }
  }
}
```

Use the actual Node executable path, or `node` if the client can find it on `PATH`. On macOS/Linux use the corresponding absolute paths. JSON backslashes must be doubled; forward slashes make Windows examples easier to copy. These examples launch Node directly, so they do not depend on a globally linked `failtrace` command or a shell wrapper.

The client starts and owns the stdio process. Running `mcp` manually in a terminal waits for protocol requests; it is not the interactive CLI. Use `run`, `compare`, `bisect`, `minimize`, or `bundle` for terminal investigations.

## Confirm the connection with a real experiment

This connection check works in **any existing working directory**. It needs only Node.js on the target command's `PATH`; it reads no project fixture files.

Ask the agent:

> List the available FailTrace tools, then run the inline Node experiment below with `failtrace_run`. Use five trials and a 5-second timeout. The fifth trial prints `FAILTRACE_DEMO` on stderr and exits with code 7. Report the actual `matchedTrials`, pass/fail counts, and artifact directory; inspect the matching trial's stderr before calling the setup successful.

The server exposes `failtrace_run`, `failtrace_compare`, `failtrace_bisect`, `failtrace_minimize`, and `failtrace_bundle`. A client may add a server prefix to their displayed names.

The unreleased source version adds optional `concurrency` to `failtrace_run`; it defaults to `1` and is not accepted by bisect/minimize. Overlapping commands can change failure probability through shared resources. Returned trials stay sorted by index. The public 0.3.1 package predates this option; see [performance guidance](PERFORMANCE.md).

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
| A known good revision became bad | `failtrace_bisect`: verified endpoint assessments, `status`, `firstBad`, and cleanup diagnostics. |
| An input reproduces but is too large | `failtrace_minimize`: accepted candidates, `status`, `finalVerified`, and `minimizedPath`. |
| Someone else needs the evidence and input | `failtrace_bundle`: selected source/input files, `configPath`, and returned bundle directory. |

### Repeat, then compare

> Investigate the checkout failure with FailTrace. Run the known command 20 times and use `{"kind":"stderr_contains","value":"checkout failed"}` as the predicate. Inspect the results, then call `failtrace_compare` with the returned run directory and the actual indices of a clean passing trial and a trial with `failureMatched: true`. Explain the differing evidence before changing code.

Comparison accepts `runA`, optional `runB`, and optional `trialA`/`trialB`. With one run and no explicit indices, it selects the first passing and first failed outcome; that failed outcome could be a timeout. With two runs it defaults to their first trials. Select explicit indices when investigating a particular target failure. If the run has no suitable pair, report that instead of inventing trial indices.

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

> If final verification reproduced the intended failure, create a local bundle from the returned `final.runDirectory`, selecting `examples/advanced-demo.js` and `package.json` as source files and the returned `minimizedPath` as input. Use `failtrace_bundle`; inspect its `repro.json`. Then run `node repro.mjs` from the returned bundle directory and report the actual predicate matches. Creating the bundle alone does not verify replay.

The bundle tool takes `run`, `files`, and `input` for this workflow. `files` is an array of paths relative to the original run's working directory. `input` is the returned input path. Other optional fields are `cwd`, `command`, `env`, and `destination`; the destination must be new. Do not substitute made-up run IDs into a follow-up call.

For your own minimization command, read candidate files through `FAILTRACE_INPUT`, or file sets through `FAILTRACE_INPUT_DIR`. A command that keeps reading the original input cannot measure the proposed reductions. For environment minimization, bundle environment overrides should include `null` for every removed original key, so inherited values cannot restore it during replay.

### Isolate a revision boundary

> The failure is absent at the verified good revision and present at the verified bad revision. Use `failtrace_bisect` with those exact refs, the reproducing command, five trials per candidate, and a threshold of three target-predicate matches. Inspect endpoint validation and every inconclusive result. Claim a sampled boundary only when `status` is `found`, and report the first-parent/monotonicity assumption and any cleanup error.

Provide `good`, `bad`, `command`, `repeat`, and `minFailures`, plus an explicit `predicate` when available. Git is required. Ignored dependencies are absent from the isolated worktree, so account for the target's setup before launching a lengthy investigation. Preserve reset/clean isolation and keep any package-manager download cache outside the temporary worktree; see the [cache guide](PERFORMANCE.md#dependency-setup-during-bisect).

In the unreleased source version, bisect/minimize trials remain sequential but stop once matches reach `minFailures`, or matches plus remaining trials cannot reach it. `repeat` is the maximum budget for each baseline/candidate/final check. A decided run can contain fewer trials without being interrupted. Check its `decision` and the operation's assessment; the observed rate is not an unbiased estimate from the full budget. Minimization still executes an independent final check.

## Read tool results correctly

MCP calls return an envelope containing `structuredContent` and a JSON text representation. Inspect the envelope's `isError` first, then the operation's own status fields. These are different layers:

- `isError: true` identifies a tool/operational error. Read the error message and any preserved artifact path.
- `isError: false` means a result was returned. A target non-zero exit is ordinary evidence, and an investigation can still be interrupted, incomplete, or inconclusive.
- For runs, `matchedTrials` counts all recorded trials that matched the target predicate, including trials omitted from the response. `statistics.failed` also includes execution failures such as timeouts. Use each trial's `failureMatched` to choose particular evidence. `statistics.failureRate` is a fraction, not a percentage value.
- For minimization, require `finalVerified: true` before claiming the reduction still reproduces. `limit_reached` can retain a verified partial reduction; it does not mean the search completed or found a global minimum.
- For bisect, inspect `status`, `reason`, and `cleanupError`. An error or inconclusive search does not establish a culprit.
- For comparison, inspect `stdout.truncated` and `stderr.truncated`; a displayed prefix is not the complete log. SHA-256 comparisons cover the complete streams.

Long MCP lists are sampled. When `trialsOmitted`, `evaluationsOmitted`, or `candidatesOmitted` is non-zero, follow the operation's `metadataPath` and candidate run paths for complete evidence. In the unreleased source version, a run with `trialStorage: "individual"` stores its authoritative trial records in `trials/<index>/result.json`; use the public Core `loadRun` API to reconstruct the full run, or inspect those individual records. Raw running/compact `run.json` need not embed all trials. Use `matchedTrials` for the full target-match count; counting only sampled `failureMatched` entries is not a valid total. Trial stdout/stderr paths are relative to the containing run's `artifactDirectory`; combine them before opening a log with the agent's file tools.

Choose a bounded experiment that fits the client's tool-call timeout. The per-trial `timeoutMs` does not bound the whole operation: repetition, minimization evaluations, setup, and cleanup add time. Client cancellation can leave partial evidence; inspect saved metadata rather than assuming nothing ran.

## Optional instructions for your repository

**Opt in deliberately:** review this snippet and copy it into the instruction file your agent reads. This guide does not create or replace any client configuration or project instruction file. Keep existing repository rules.

Claude Code supports project instructions in `CLAUDE.md`; see its [official memory documentation](https://code.claude.com/docs/en/memory). Cursor supports project rules and `AGENTS.md`; see its [official rules documentation](https://cursor.com/docs/rules). Use the appropriate existing file for your client.

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

For minimization, make the target read FAILTRACE_INPUT or FAILTRACE_INPUT_DIR.
Check finalVerified and status before claiming a reduction works. Bundle only
explicitly selected source/input files, and report whether replay was tested.

Follow the user's task scope and this project's permissions. These instructions
do not authorize client reconfiguration, publishing, or unrelated changes.
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server cannot start | Node version, executable path, completed build, and `dist/cli/index.js` location. |
| Demo or project command is missing | The configured `--cwd` and the tool's optional `cwd`; relative paths resolve from the server directory. |
| Tool returns immediately with a failed target | Inspect the trial exit/status and logs; a command error is data, not proof of the intended predicate. |
| Long call is canceled | The client's request timeout and cancellation status; read partial metadata before starting another experiment. |
| Agent keeps using shell loops | Confirm the five tools are connected, ask for one by name, and opt into the repository instruction snippet if desired. |
| Bundle does not replay | Explicit source-file selection, target dependency setup, selected input, environment removals, and command portability. |

Client setup references were checked against official documentation on **2026-09-04**. The schemas and result fields described here come from this repository's [MCP adapter](../src/mcp/index.ts), [Core implementation](../src/core), and [README](../README.md).

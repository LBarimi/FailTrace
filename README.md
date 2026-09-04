# FailTrace

**Reproduce. Isolate. Minimize.**

FailTrace turns flaky and difficult-to-reproduce software failures into measurable, inspectable evidence. Built for humans and coding agents.

```sh
failtrace run "npm test -- checkout" --repeat 20
```

```text
FailTrace

Command   npm test -- checkout
Trials    20
Timeout   30.00s

Running

  01  PASS        1.42s
  02  PASS        1.37s
  03  FAIL        1.51s  exit 1
  ...

Results

  Trials         20 / 20
  Passed         13
  Failed         7
  Failure rate   35.0%

Duration

  Min            1.31s
  Avg            1.44s
  Max            1.62s

Failure reproduced.

Artifacts:
.failtrace/runs/<run-id>
```

*Representative output; durations and results depend on the target command.*

**Available now:** sequential command repetition, per-trial timeouts, interruption handling, failure statistics, and inspectable output artifacts. Isolation and minimization are future milestones.

## Quick start

Requires **Node.js 22.12 or newer** and npm. Install from source:

```sh
git clone https://github.com/LBarimi/FailTrace.git
cd FailTrace
npm install
npm run build
npm link
failtrace run "node examples/flaky-demo.js" --repeat 10
```

The demo always produces **7 passes, 3 failures, and a 30.0% failure rate**. It exits with code `1` because the target failures were reproduced. Run it from the repository directory.

To use the build without linking:

```sh
node dist/cli/index.js run "node examples/flaky-demo.js" --repeat 10
```

These instructions use the source checkout; they do not require a published npm release.

## Why FailTrace?

Running a test once tells you what happened once. Repeating it by hand leaves you with scattered logs and an uncertain failure rate.

FailTrace handles the repetitive experimental work: execute the same command, preserve each result, and report how often it failed and how long it took. A developer or coding agent can inspect one run directory instead of collecting dozens of terminal sessions. No AI API, account, server, or external service is involved.

A **trial** is one target-command execution. A **run** is the collection of trials created by one FailTrace invocation.

## CLI usage

```sh
failtrace run "<command>" [--repeat N] [--timeout DURATION]
failtrace --help
failtrace --version
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--repeat N` | `10` | Positive safe integer; trials run sequentially. |
| `--timeout DURATION` | `30s` | Positive per-trial limit, such as `500ms`, `30s`, or `2m`. |
| `--help`, `-h` | | Show usage. |
| `--version`, `-v` | | Show the FailTrace version. |

Timeouts without a suffix use milliseconds. Fractional units such as `1.5s` are accepted if they resolve to whole milliseconds. The maximum is `2147483647ms`. Options also accept `--repeat=20` and `--timeout=30s`.

```sh
failtrace run "npm test -- checkout" --repeat 20
failtrace run "npm test" --repeat 5 --timeout 2m
failtrace run "node examples/flaky-demo.js" --repeat 10 --timeout 5s
```

Quote the entire target command so its arguments remain together. FailTrace passes it to the platform shell in your current directory: normally `cmd.exe` on Windows and `/bin/sh` on macOS/Linux. Inner quoting, shell operators, and environment-variable syntax follow that shell. For complicated commands, put the logic in a script and run the script. Commands execute with your normal permissions and inherited environment. They receive no interactive stdin; stdout and stderr go to artifact files.

The process must exit with code `0` to pass. Non-zero exit codes, signals, timeouts, spawn errors, and interrupted active trials count as failures. A missing command usually appears as the shell's non-zero exit; failure to start the shell itself is a distinct spawn error. Timeouts and interruptions are labeled separately in the terminal and metadata.

| FailTrace exit code | Meaning |
| --- | --- |
| `0` | All completed trials passed. |
| `1` | At least one target trial failed, timed out, or could not start. |
| `2` | Invalid usage or an internal error, such as artifact write failure. |
| `130` | Interrupted by Ctrl+C / SIGINT. |
| `143` | Interrupted by SIGTERM. |

Ctrl+C stops new trials, terminates the active trial when possible, saves the results, and prints a partial summary. Statistics cover recorded trials, including an interrupted active trial; trials that never started are excluded. Failure rate is the failed count divided by recorded trials, with zero used for an empty run. Durations use elapsed wall-clock time per recorded trial, including failed trials and process cleanup. A timed-out trial can therefore take slightly longer than its configured limit.

## Deterministic demo

The tiny [demo](examples/flaky-demo.js) fails every third trial. FailTrace supplies `FAILTRACE_TRIAL_INDEX`, starting at `1` for each run. There is no random number generator or persisted counter, so repeat recordings produce the same pass/fail sequence:

```text
Trial   01  02  03  04  05  06  07  08  09  10
Result   P   P   F   P   P   F   P   P   F   P
```

Run the quick-start command to get an immediate terminal demo suitable for a screenshot or GIF. Real commands are unchanged except for the supplied trial-index environment variable; their behavior may still depend on shared state, clocks, and external systems.

## Artifacts

Every run gets a collision-resistant directory under the current project's `.failtrace/runs/`:

```text
.failtrace/
  runs/
    <run-id>/
      run.json
      trials/
        001/
          result.json
          stdout.txt
          stderr.txt
        002/
          result.json
          stdout.txt
          stderr.txt
```

`run.json` records the schema and FailTrace versions, command, working directory, requested trials, timeout, timestamps, run status, trial metadata, and aggregate statistics. Each `result.json` records its index, command, timestamps, duration, exit code, signal, status, timeout/spawn indicators, termination reason, output paths, and an error message when available.

Output streams directly to `stdout.txt` and `stderr.txt`; JSON references the files instead of duplicating output. Trial output paths are relative to the run's `artifactDirectory`. Metadata is written using a temporary file followed by a rename, and completed trial artifacts are retained after interruption.

Artifacts are local, inspectable, and safe to delete when no run is active. `.failtrace/` is ignored by Git. Target output can contain whatever your command prints, so inspect artifacts before sharing them.

## Programmatic Core API

The reusable engine lives in `src/core`. After building, code in the repository can use it directly:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTrials } from './dist/core/index.js';

const controller = new AbortController();
const summary = await runTrials({
  command: 'node examples/flaky-demo.js',
  repeat: 10,
  timeoutMs: 5_000,
  signal: controller.signal,
  onTrialComplete: (trial) => console.log(trial.index, trial.status),
});

console.log(summary.statistics);
const failure = summary.trials.find((trial) => trial.status !== 'passed');
if (failure) {
  console.log(await readFile(join(summary.artifactDirectory, failure.stderrPath), 'utf8'));
}
```

Core also accepts `cwd`, `env`, and `artifactsDir` (the parent of `runs/`, defaulting to `<cwd>/.failtrace`). Output is exposed through paths, keeping large logs out of memory. Use an `AbortSignal` to cancel; Core does not install process-global signal listeners. Target failures are returned as data. Invalid configuration and FailTrace's own operational errors reject the call.

## Development

Read [AGENTS.md](AGENTS.md) and this README before changing code.

```sh
npm install
npm test
npm run typecheck
npm run build
node dist/cli/index.js run "node examples/flaky-demo.js" --repeat 10
```

```text
src/
  core/       Execution, orchestration, statistics, artifacts, public types
  cli/        Argument parsing, terminal output, process signal handling
tests/        Deterministic unit and integration tests
examples/     Small runnable demonstrations
```

The project uses strict TypeScript, Node.js built-ins, and Vitest. CLI depends on Core; Core never imports CLI code. Tests use local deterministic fixtures and make no external network calls.

## Philosophy and current limits

- Local-first, deterministic orchestration with readable JSON and text evidence.
- Small modules and explicit data structures; dependencies and abstractions must solve a current problem.
- One command, one working directory, sequential trials. FailTrace does not reset files, databases, or other target state between trials.
- Failure currently means anything other than a successful exit. There are no custom predicates or automatic stdout/stderr comparisons yet.
- The observed failure rate is a sample statistic, not a confidence estimate or proof that a command is reliable.
- Process-tree cleanup is best effort: process groups on macOS/Linux and `taskkill` on Windows. Detached or escaped descendants may survive. Force-killing FailTrace itself or losing power cannot produce the same clean finalization as Ctrl+C.
- Output is streamed to disk without a size cap. Long runs or verbose commands can consume significant disk space.
- Target commands still need shell syntax appropriate for their platform. No isolation, sandbox, or portable environment capture is provided.

## Roadmap — planned, not implemented

| Milestone | Direction |
| --- | --- |
| **1 — Available now** | Command repetition, evidence, timeouts, interruption, and statistics. |
| **2 — Failure predicates and comparison** | Specific exit codes, text/regex matching, PASS vs FAIL output comparison, environment snapshots; `failtrace compare`. |
| **3 — Regression isolation** | `failtrace bisect` with repeated trials at candidate commits to investigate flaky regressions. |
| **4 — Failure minimization** | Delta-debugging-inspired reduction of text, JSON, arrays, files, test cases, and environment variables. Accept a reduction only while the target failure still reproduces. |
| **5 — Reproduction bundles** | Portable reproduction instructions, configuration, scripts, inputs, and logs under `.failtrace/reproduction/`. |
| **6 — MCP** | A thin adapter exposing stable Core capabilities to MCP-compatible coding agents. |

Future MCP tools may include `failtrace_run`, `failtrace_compare`, `failtrace_bisect`, `failtrace_minimize`, and `failtrace_bundle`. Algorithms will remain in Core. There is no MCP server in the current release.

There are no plans in milestone 1 for SaaS, cloud storage, authentication, telemetry, AI API calls, a web UI, or a plugin framework.

## License

[MIT](LICENSE)

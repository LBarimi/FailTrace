# FailTrace

**Reproduce. Isolate. Minimize.**

Turn a flaky command into measured failures, a smaller reproducer, and evidence someone else can replay. Built for developers and coding agents. Local execution, inspectable files, no AI API or telemetry.

[![CI](https://github.com/LBarimi/FailTrace/actions/workflows/ci.yml/badge.svg)](https://github.com/LBarimi/FailTrace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

```sh
failtrace run "npm test -- checkout" --repeat 20 --stderr-contains "checkout failed"
```

**One run, reusable evidence:** compare passing and failing logs, test candidate commits repeatedly, remove input while preserving the failure, then package a local reproduction.

## Quick start

Requires **Node.js 22.12+ and npm**. Run the guided demo from any directory:

```sh
npx --yes failtrace demo
```

The demo runs real experiments: **7 passes / 3 failures**, a six-element JSON input reduced to **`["BUG"]`**, and a bundle ready to replay. It preserves evidence under `.failtrace/demos/<id>/` and prints the replay command. The demo exits `0` when those expected results are verified. Replaying its intentionally failing example exits `1`.

![A real FailTrace demo: 7 passes, 3 failures, input reduced to BUG, and a replayable bundle](docs/assets/demo.svg)

Install the command for everyday use:

```sh
npm install --global failtrace
failtrace demo
```

Prefer a project dependency? Use `npm install --save-dev failtrace` and run `npx failtrace`. Neither a source checkout nor a TypeScript build is required.

### GitHub release alternative

The verified [v0.3.0 release archive and checksum](https://github.com/LBarimi/FailTrace/releases/tag/v0.3.0) remain available. To run that exact GitHub package:

```sh
npm exec --yes --allow-remote=root --package=https://github.com/LBarimi/FailTrace/releases/download/v0.3.0/failtrace-0.3.0.tgz -- failtrace demo
```

For this archive alternative, the command-scoped `--allow-remote=root` option permits the explicitly requested URL on npm 12. It is unnecessary for the registry commands above and does not change your npm configuration. Older npm versions that do not recognize it can omit it. See [npm's URL install policy](https://docs.npmjs.com/using-npm/config/#allow-remote).

## Use it on your own failure

```sh
# Measure a known failure signature.
failtrace run "npm test -- checkout" --repeat 20 --stderr-contains "checkout failed"

# Compare the first passing and failed trial from the printed run ID.
failtrace compare <run-id>

# Reduce an input read by your script through FAILTRACE_INPUT.
failtrace minimize --input cases.json --format json --command "node reproduce.js" --stderr-contains "checkout failed"

# Package the final run and reduced input paths printed by minimization.
failtrace bundle <final-run-directory> --file reproduce.js --input <minimized-input-path>
```

Paths in angle brackets come from the preceding result. If a failed outcome is a timeout or setup problem, select a matching trial explicitly when comparing. Use `--json` for machine-readable results.

| Problem | Operation | Evidence you get |
| --- | --- | --- |
| “It fails sometimes.” | `run` | Failure frequency, predicate matches, durations, stdout/stderr |
| “What changed between PASS and FAIL?” | `compare` | Bounded output differences, full hashes, selected environment changes |
| “Which revision introduced it?” | `bisect` | Repeated candidate trials and a sampled first-parent boundary |
| “The reproducer is too large.” | `minimize` | Reduced text, JSON/arrays, files, or environment keys; final verification |
| “Someone else needs the evidence?” | `bundle` | Selected source/input, original evidence, included Core engine, replay scripts |

[Full command reference](docs/CLI.md) · [Runnable examples](examples) · [Implementation and verification](docs/IMPLEMENTATION.md)

**Unreleased performance improvements in the source checkout:** `run --concurrency N` opts into overlapping trials while the default stays `1`. Shared ports, files, databases, and resource contention can change failure probability. Bisect/minimize keep sequential trials and stop when their classification threshold is decided. Ordinary runs still attempt the full requested count. See [performance measurements and operational guidance](docs/PERFORMANCE.md) for metadata recovery, external dependency caches, and remaining tradeoffs. These changes are not included in the published 0.3.1 package.

**[Real bug case: reduce a Prettier formatting failure from 464 to 11 characters →](https://github.com/LBarimi/FailTrace/tree/main/examples/cases/prettier-chain)** The runnable investigation uses pinned affected/fixed releases, rejects unrelated parser errors, and produces a replayable bundle. The case includes authored surrounding code and links to the original upstream report.

## For coding agents

FailTrace handles the repeated experiments; the agent investigates the resulting evidence. Use it through the CLI with `--json`, or connect its official-SDK stdio MCP server:

```sh
failtrace mcp --cwd /absolute/path/to/your/project
```

It exposes `failtrace_run`, `failtrace_compare`, `failtrace_bisect`, `failtrace_minimize`, and `failtrace_bundle`, with typed inputs, structured results, artifact paths, and cancellation. Target failures are ordinary evidence. Large responses retain full metadata on disk; `matchedTrials` reports the complete predicate-match count.

**[Connect Codex, Claude Code, Cursor, or another MCP client →](docs/AGENT-WORKFLOWS.md)**

After connecting, try asking:

> This checkout test sometimes fails. Use FailTrace to measure its known failure signature, compare passing and matching trial evidence, and report what the results establish before changing code.

The guide includes client configuration, bounded experiments, result interpretation, and an optional instruction snippet for your own repository. Installing a server makes the tools available; it does not guarantee an agent will choose them.

## What the results establish

- Repetition measures observed outcomes under the chosen execution settings. Bisect uses repeated trials and a failure threshold, assuming a monotonic boundary on first-parent history. Early-stopped classification samples are not full-run failure-rate estimates and do not provide statistical confidence.
- Minimization accepts only reproducing candidates and independently rechecks the result. Check `status` and `finalVerified`; limits and inconclusive runs are reported. Reductions are local to the supported removal operations.
- Bundles include selected files and the Node Core engine. Target dependencies, services, uncaptured environment state, and shell portability still need attention. Creation never executes the bundle.
- Commands run with your local permissions. Process cleanup is best effort. Logs can contain private output and grow without a size cap; `.failtrace/` is ignored by this repository.

`run` exits `1` when it records failed outcomes; that is useful evidence. Invalid usage and incomplete investigations use `2`. Interruptions use `130`/`143`. See the [reference](docs/CLI.md#artifacts-and-exit-codes) for details.

## Contribute a useful debugging workflow

**[Tell us where FailTrace helped or got stuck](https://github.com/LBarimi/FailTrace/issues/new?template=workflow.yml).** A real command, a first-install problem, or an agent integration is useful feedback. Sharing private logs is optional; remove secrets first.

Our goal is adoption and repeat use, not feature count. Contributions that shorten the path to useful evidence are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [adoption priorities](docs/ADOPTION.md).

To develop from source:

```sh
git clone https://github.com/LBarimi/FailTrace.git
cd FailTrace
npm ci
npm run build
npm run demo
npm run typecheck
npm test
npm run test:package
```

Core is a reusable TypeScript API exported by `failtrace`. Algorithms live in `src/core`; CLI, demo orchestration, and MCP call it. CI checks Windows, macOS, and Linux with Node.js 22 and 24.

[MIT license](LICENSE)

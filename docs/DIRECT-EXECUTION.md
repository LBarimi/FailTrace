# Executables and literal arguments

This functionality is **unreleased in the source checkout**. Build with `npm ci` and `npm run build`; published 1.1.0 does not support these options.

Use an existing program that accepts an input filename without writing an environment-variable adapter or constructing shell commands:

```sh
node dist/cli/index.js minimize --input failing.json --format json --exec node --arg check.mjs --arg "{input}" --stderr-contains "TARGET_FAILURE"
```

The checker receives the current candidate filename as its first argument. Spaces, quotes and shell operators in that filename stay part of the argument. The same syntax can launch Python, a compiled test executable, or another installed runtime; install the target's own dependencies first.

## Choosing execution mode

- Without `args` in Core/MCP, or without `--exec` in the CLI, the existing quoted command runs in the platform shell.
- With `args`, including `[]`, `command` names an executable and its arguments are passed literally with shell parsing disabled.
- In the CLI, choose `--exec PROGRAM` and repeat `--arg VALUE`. An argument can start with a dash: `--arg --help` passes the target's help option. `--arg=` passes an empty argument. Do not also provide a positional shell command or `--command`.
- Pipelines, redirects, wildcard expansion and environment-variable expansion require the existing shell-command mode. Direct mode does not perform any of them.
- On Windows, `.cmd` and `.bat` shims require shell mode. Direct mode does not silently enable a shell; use the real executable, such as `node` with a script filename, or keep the quoted shell command.

For example, this passes `--filter` and `checkout` as separate arguments:

```sh
node dist/cli/index.js run --exec node --arg tests.mjs --arg --filter --arg checkout --repeat 20
```

Arguments are limited to 4,096 strings. Executable/command UTF-8 bytes plus the compact JSON representation of arguments must fit the existing 64 KiB command allowance. Null bytes are rejected. Argument contents are saved in local evidence and can contain private values; inspect them before sharing.

## Core and MCP

```js
import { runTrials, minimizeFailure } from 'failtrace';

const run = await runTrials({
  command: process.execPath,
  args: ['check.mjs', 'failing.json'],
  repeat: 10,
  predicate: { kind: 'stderr_contains', value: 'TARGET_FAILURE' },
});

const reduced = await minimizeFailure({
  command: process.execPath,
  args: ['check.mjs', '{input}'],
  input: 'failing.json',
  format: 'json',
  predicate: { kind: 'stderr_contains', value: 'TARGET_FAILURE' },
});
```

Use the source-linked package for this example until a supporting version is published. The existing MCP run, bisect, minimize and verify tools accept the same optional `args` array. The bundle tool accepts an explicit argument override. No extra MCP tool or configuration format is needed.

## Candidate input binding

Minimize replaces only an **entire argument equal to `{input}`**. `--file={input}` and text embedded in another argument are literal; use separate arguments if the target supports them. Shell command strings never substitute this token.

For text, JSON and environment input formats, the replacement is the candidate file path. For files format, it is the candidate directory. The existing `FAILTRACE_INPUT` / `FAILTRACE_INPUT_DIR` environment variables remain available. Environment minimization also continues applying each candidate's selected variables.

Each trial records the actual argument values it executed. The minimization result records the template. Inspect both `status` and `finalVerified`; input binding does not change the evidence or minimality guarantees.

## Verify and saved evidence

Verify always requires the caller's explicit current command and execution mode. It does **not** inherit arguments from the baseline. A change to any argument, or between shell and direct execution, is a `command` context change and needs an explicit allowance with a reason. Prefer preserving the same arguments when evaluating a source patch.

Saved runs and trials include `args` only for direct execution. Comparison includes arguments and execution mode in `commandChanged`; inspection and verification check that trial and run command identities agree. Use a supporting build to inspect these records: older readers cannot enforce the new execution identity.

## Portable bundle replay

Minimization records absolute candidate paths locally. Select the reduced input and explicitly replace machine-specific executable/input values when building a portable replay:

```sh
node dist/cli/index.js bundle <final-run-id-or-path> --file check.mjs --input <minimized-input-path> --exec node --arg check.mjs --arg "{input}"
```

The bundle stores the reviewed argument template, and its included engine binds the selected input path after relocation. Creating a bundle never runs the target. An entire argument equal to `{input}` requires an explicit input selection. The portable-command check rejects recorded absolute executable and candidate paths; use a portable override and include the needed files. This check does not discover every path embedded in arbitrary argument text or target configuration, so inspect those values before sharing.

With no override, bundle creation preserves the recorded execution mode. A `--command` override selects shell mode; `--exec` selects direct mode. Core/MCP follow the same rule: a command-only override selects shell mode, while an explicit `args` array selects direct mode. Review `repro.json`, source files and prerequisites before running `node repro.mjs`.

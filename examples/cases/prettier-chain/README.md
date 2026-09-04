# A formatter that changes its own output

**FailTrace reduced a 464-character TypeScript input to 11 characters while preserving a real Prettier defect.** The affected release changes its output when formatting it a second time; the fixed release is stable.

This is a maintainer-authored case study of [Prettier issue #15435](https://github.com/prettier/prettier/issues/15435), reported against **3.0.3** and fixed by [PR #15522](https://github.com/prettier/prettier/pull/15522) in [3.2.0](https://prettier.io/blog/2024/01/12/3.2.0/#fix-non-idempotent-formatting-of-method-chain-with-empty-line-15522-by-seiyab). The upstream reproducer was already small. `fixture.ts` adds clearly identified application context to demonstrate how reduction removes irrelevant code.

## Reproduce the investigation

With Node.js 22.12+ and npm:

```sh
git clone --depth 1 https://github.com/LBarimi/FailTrace.git
cd FailTrace/examples/cases/prettier-chain
npm ci --ignore-scripts --allow-remote=root
npm run investigate
```

This installs two exact Prettier versions and the **published FailTrace 0.3.0 package**. A TypeScript build or global installation is unnecessary. The case is supplied in the repository; the main FailTrace package contains only its built-in demos. npm 12 needs the command-scoped URL permission for the FailTrace archive; older npm versions that do not recognize the option can omit it.

The investigation records three affected-version trials and three fixed-version trials, compares their output, minimizes the input, independently verifies the final failure, checks the reduced input against the fixed version, and creates a bundle. It exits `0` only when those checks succeed. The original fixture remains intact; evidence stays under this directory's `.failtrace/`.

## Recorded result

A local run on Windows with Node.js 24.19.0 produced:

| Check | Result |
| --- | --- |
| Prettier 3.0.3, original input | 3 / 3 formatting mismatches |
| Prettier 3.2.0, original input | 3 / 3 successful exits, no mismatches |
| Text reduction | 464 → 11 characters, 92 evaluations |
| Final affected-version check | Same failure verified |
| Prettier 3.2.0, reduced input | Successful exit, stable formatting |

The reduced input was:

```ts
t.r()

.e()
```

On the affected release, the first formatting pass produces `"t.r()\n.e();\n"`; the second produces `"t.r().e();\n"`. The significant blank line survives the reduction. The fixed release produces the same output on both passes.

This case is deterministic. The counts are observed trials of pinned releases, and the reduction is local to FailTrace's removal operations. They do not establish a failure probability or a globally smallest program. Different line endings can change the initial character count; inspect your generated report for your actual result.

Each investigation prints the paths to `case-report.json`, the complete minimization history, and the reproduction bundle. `comparison.json` beside the report contains the affected/fixed output comparison. No source program is executed: the target only reads and formats candidate text.

## Why this predicate matters

`check.mjs` calls the selected formatter twice with the same `typescript` parser and LF output option. It prints `PRETTIER_NOT_IDEMPOTENT` on stderr only after both calls succeed and their outputs differ. It also checks the imported package version.

Deleting input can create invalid TypeScript. Such candidates exit `2` with a separate diagnostic and never print the failure signature. The checker does not echo invalid source into stderr, so a signature inside that source cannot impersonate the defect. `npm test` checks these cases against both pinned packages.

FailTrace's `passed` count with a custom predicate means the predicate did not match. The investigation additionally checks actual exit codes and normal process termination for the fixed control; a missing dependency or parser error is insufficient evidence of a fix.

## Run the steps yourself

From this case directory after installation:

```sh
npm exec --offline -- failtrace run "node check.mjs affected" --repeat 3 --stderr-contains PRETTIER_NOT_IDEMPOTENT
npm exec --offline -- failtrace run "node check.mjs fixed" --repeat 3 --stderr-contains PRETTIER_NOT_IDEMPOTENT
npm exec --offline -- failtrace compare <affected-run-directory> <fixed-run-directory>
npm exec --offline -- failtrace minimize --input fixture.ts --format text --command "node check.mjs affected" --stderr-contains PRETTIER_NOT_IDEMPOTENT --max-evaluations 250
npm exec --offline -- failtrace bundle <final-run-directory> --file check.mjs --file package.json --file package-lock.json --input <minimized-input-path>
```

Replace angle-bracket paths with the preceding command's output. The first command exits `1` because it reproduced the requested failure. A completed, verified minimization exits `0`. Add `--json` to FailTrace commands for structured results.

## Replay elsewhere

Copy the printed bundle directory to another location or machine. From inside the copied bundle:

```sh
cd source
npm ci --omit=dev --ignore-scripts --allow-remote=root
cd ..
node repro.mjs
```

The included engine needs Node.js. The target additionally needs the two pinned Prettier packages, installed in the bundle's `source/` directory. `--omit=dev` avoids reinstalling the FailTrace development tool; the bundle already contains its engine. Installation needs registry access or cached dependencies. Replay itself runs locally and exits `1` when it reports `Target failure reproduced: 1 / 1`.

The original published package and these old Prettier versions remain pinned to make this historical experiment repeatable. Use the appropriate supported formatter version in your own project.

## Ask an agent to investigate

Connect the installed FailTrace MCP server with its working directory set to this case directory, following the [agent setup guide](../../../docs/AGENT-WORKFLOWS.md). Then ask:

> `node check.mjs affected` formats a TypeScript input differently on the second pass. Use FailTrace to establish the specific stderr signature, compare the affected and fixed commands, and minimize `fixture.ts` while preserving that signature. Parser errors are not this defect. Verify that the reduced input still fails on the affected version and actually exits zero on the fixed version. Package the final matching run and reduced input with the checker and dependency manifests. Use returned artifact paths and explain what the result establishes.

Relevant tools are `failtrace_run`, `failtrace_compare`, `failtrace_minimize`, and `failtrace_bundle`. No Git bisect is needed for this case: the comparison uses two known published versions. Installing the server makes these tools available; an agent's actual tool choice and useful result must still be observed.

Prettier is MIT licensed; npm retains its license files. This repository contains the case harness and authored context, with upstream attribution above. The historical bug and its fix belong to the upstream project; this example demonstrates an independently reproducible FailTrace workflow.

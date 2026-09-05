# Original debugging workflows

**Unreleased source examples.** Build this checkout to run these cases. The published `failtrace@1.1.0` package does not include this workflow command or execution checkpoints.

From the repository root:

```sh
npm ci
npm run test:workflows
```

The command creates new copies under `.failtrace/workflows/<id>/`, runs the checks, and prints a report path. It preserves the example source files and saves each investigation's outputs. No target dependencies or network services are needed after the development dependencies are installed. Importing `examples/workflows/investigate.mjs` does not execute a command.

## A batch silently loses newer data

An importer receives multiple revisions of an entity. Its deduplication keeps the first record for an ID, so a newer revision later in the batch disappears. The original 12-record input includes surrounding records that are irrelevant to that defect.

FailTrace records the `IMPORT_REVISION_LOST` failure, reduces the input to two records for the same ID, and separately rechecks that smaller reproducer. The independent checker verifies expected latest revisions rather than looking for a synthetic trigger word. Removing either record makes the reduced case succeed. The supplied fix retains the newer revision and succeeds with both the original and reduced input.

That result changes the next debugging step: inspect how duplicate IDs are updated, then recheck the fix against the preserved input. The reduction is an observed reproducer, not a promise of a globally smallest input.

The workflow also tests three misleading candidates:

| Candidate | Observation | What to do next |
| --- | --- | --- |
| A source edit that keeps the faulty behavior | `target_observed` | Continue investigating the same defect |
| An implementation that fails during setup | `inconclusive` | Repair execution before evaluating the patch |
| A checker replaced with exit `0` | `inconclusive` | Restore the intended check |
| The supplied revision-handling fix | `target_not_observed` | Review the healthy sample and the declared intervention |

The baseline records `IMPORT_CHECK_COMPLETED` separately from the failure signature. Verify requires that checkpoint after the source change. See the [step-by-step CLI recipe](EXECUTION-EVIDENCE.md) to run and modify each stage yourself.

Input minimization rejects malformed candidates through its specific failure predicate. The final reduced input is then run with the completion checkpoint before creating a bundle. The workflow replays that bundle and confirms the target failure, including the completed check. Original input bytes remain unchanged.

## Two overlapping updates become one

A counter reads its current value, waits asynchronously, then writes the incremented value. Two calls that overlap can both read the old value and overwrite each other. Sequential calls succeed.

The second fixture uses an explicit promise barrier to produce three overlapping and three serial schedules. The affected implementation loses an update in each overlapping schedule. The fixed implementation performs its read/update after the wait and retains both increments in all six schedules.

The six schedules are predeclared deterministic controls. They are **not** a measurement of a naturally occurring failure probability. The same workflow rejects ineffective changes, unrelated setup errors and skipped checks, then compares the baseline with the supplied fix.

This example helps distinguish an ordering problem from a generic intermittent crash: compare the saved passing and failing trials, identify the overlapping update, and verify a targeted change under the same declared schedules.

## Evidence and validation scope

`workflow.json` links the baseline, reduction where applicable, candidate verification reports and replay bundle. Those records can contain local paths and target output; review them before sharing. The terminal summary includes only the authored case outcomes and a report path relative to the invocation directory.

CI runs the original fixture tests and source workflows on the existing OS/Node matrix. The installed-package gate runs the bundled examples from a fresh consumer, resolving its Core and CLI from that installation. A real MCP stdio connection also exercises the installed examples through run, compare, minimize, Verify, bundle and saved-evidence inspection. These are maintainer checks; they do not claim that an autonomous agent chose the tool or that an independent developer adopted it.

All fixtures are authored for FailTrace. They demonstrate recognizable debugging problems under controlled conditions, and do not establish production reliability, broad performance superiority, statistical confidence or defect elimination.

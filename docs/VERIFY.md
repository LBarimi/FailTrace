# Verify a proposed fix

**Status: implemented in source, not yet released on npm.** Core `verifyFix`, CLI `verify`, and MCP `failtrace_verify` enforce the same evidence checks. Build this checkout to use them; older published packages can use the manual run/compare procedure below. A minimization's `finalVerified` only says the reduced input still reproduces the defect; it does not verify a code fix.

## Capture a baseline, then verify

Before changing code, select the original failure signature, input and setup files. For example, adapt these project-owned paths and command:

```sh
failtrace run "node reproduce.js" --repeat 20 --timeout 30s --stderr-contains "checkout failed" --context-input cases.json --context-setup package-lock.json --context-source reproduce.js --capture-env NODE_ENV,TZ --json
```

Each `--context-*` option implies `--capture-context` and can be repeated. The paths must identify regular files relative to the command's working directory; directories, symlinks and traversal are rejected. Source files select a files-only identity scope, even inside Git; changes outside that declared scope are not covered. Without source files, Git identity is captured when available. `--capture-context` alone enables that Git mode without selecting input/setup files. Outside Git, declare source files with `--context-source`; unknown source identity is not eligible for verification. Empty categories mean **no files were declared**, not that all inputs or dependencies were discovered.

Keep the returned `artifactDirectory`. After applying the code change, use that actual path in place of the placeholder:

```sh
failtrace verify <baseline-run-directory> --command "node reproduce.js" --cwd . --allow-change "source:repair checkout handling" --json
```

The current command and working directory are required; saved metadata is never implicit permission to execute its command. Verify inherits the baseline predicate, selected context files, captured environment keys, repeat count, timeout and concurrency. Choose a different candidate budget with `--repeat N` before execution. It always attempts that full budget and does not use bisect/minimize's threshold stopping.

Source, input, setup, selected environment, command, timeout and concurrency differences must be explicitly declared. Repeat `--allow-change FIELD:REASON` for intended interventions; the report keeps both identities/settings and the reason. For example, a dependency fix can require both `source` and `setup` changes. Allowing a change does not excuse missing evidence, unstable files or an unhealthy command. The canonical working directory must remain the same and cannot be allowed to change. Omitting `--capture-env` does not capture every ambient variable.

The default healthy nonmatching exit is `0`. A target that legitimately succeeds with another exit code can declare repeatable `--healthy-exit-code N` values, replacing that default. This policy applies to both baseline and candidate evidence. An expected target match is a valid observation even when its exit code is nonzero; a nonmatch that exits 1 due to a syntax error is unhealthy.

| Result status | Meaning | CLI exit |
| --- | --- | --- |
| `target_observed` | The target failure was observed in eligible, comparable candidate evidence. | `1` |
| `target_not_observed` | A complete, healthy, comparable candidate sample had no target matches. This does not prove elimination or improvement. | `0` |
| `inconclusive` | Baseline eligibility, context, completion or execution health prevents the conclusion. Inspect `reasons`. | `2` |
| `interrupted` | Cancellation preserved available partial evidence. | `130` for SIGINT, `143` for SIGTERM |

Invalid CLI/API options and operational exceptions use exit `2`. An ineligible baseline returns an inconclusive report without executing the candidate. Reports live at `.failtrace/verifications/<id>/verify.json`; use the returned `metadataPath` rather than constructing paths. They link both run directories, the preselected plan, complete matched/healthy/unhealthy counts, eligibility reasons and context changes. `healthyTrials` counts valid executions, including normal target matches; it is not a count of successful fixes. Unhealthy observations are separated into `infrastructureTrials` (timeouts, signals, spawn/cleanup/predicate errors), `unrelatedFailureTrials` (normal nonmatches with disallowed exit codes), and `invalidEvidenceTrials` (missing or inconsistent records).

Core callers use `runTrials({ command, captureContext: { inputFiles, setupFiles, sourceFiles }, ... })`, then `verifyFix({ baseline, command, cwd, allowChanges: [{ field: 'source', reason: '...' }] })`. `assessBaselineEligibility` can explain why saved evidence needs replacement. MCP uses the same fields on `failtrace_run` and `failtrace_verify`, with explicit `command` and `cwd` required for verification. Its counts cover all trials; context file lists and change values are summarized, with full identities at `metadataPath`.

Context snapshots are taken before and after execution, not continuously. They hash declared files or use bounded Git commit/patch identity plus raw tracked/untracked regular-file hashes. Git mode rejects unsupported symlinks, submodules and index flags that hide changes instead of treating incomplete identity as comparable. Uncaptured ignored dependencies, external services, databases, target runtimes and undeclared variables remain outside this evidence. Use project-owned reset/setup scripts, review captured scope, and never treat matching hashes as proof of environmental isolation.

## Compatibility: full runs before and after a change

The following recipe uses commands available in the published 0.3.1 package and the current source. Replace the example command and failure message with those from your project. Decide the repeat count before observing either result, and keep the input, setup, working directory, timeout and relevant environment the same. Use your project's reset script if trials change external state; sequential execution alone provides no reset or independence guarantee.

Before editing the code:

```sh
failtrace run "npm test -- checkout" --repeat 50 --timeout 30s --stderr-contains "checkout failed" --json
```

Keep the returned run ID/directory and original input. Confirm that this baseline actually contains the intended target failure in `failureMatched`, then make the proposed fix. Repeat the same command with the same predicate and budget:

```sh
failtrace run "npm test -- checkout" --repeat 50 --timeout 30s --stderr-contains "checkout failed" --json
```

Each invocation creates separate evidence. A recorded failure makes `run` exit 1 while still producing JSON; do not chain the baseline and the rest of the investigation with `&&`. These commands use sequential defaults on both published and source versions. If deliberately using source-only concurrency, keep the same setting in both runs and record it.

Inspect both complete runs before drawing conclusions:

| Check | What to require |
| --- | --- |
| Completion | `status: "completed"`, no run error, and all requested trials recorded; no partial/early-decided frequency sample |
| Intended failure | Count explicit `failureMatched: true` values, not `statistics.failed`; the baseline must contain at least one known target match |
| Valid target execution | Every trial exited normally, with no timeout, signal, spawn or cleanup/predicate error |
| Healthy nonmatch | Each nonmatching trial has the expected successful exit code, normally 0; inspect any other exit rather than accepting it as a fix |
| Comparable experiment | Same failure rule, timeout, input/setup, concurrency and relevant environment; record the code change and any intentional command/dependency change |
| Honest interpretation | Report counts and changed conditions; avoid declaring a defect eliminated or a statistically meaningful improvement from raw counts alone |

A substring predicate can miss an unrelated syntax error, yielding `failureMatched: false` and `status: "passed"` even though the process exited 1. That means the selected predicate did not match, not that the program worked. Check raw exit/termination/error fields. On a complete ordinary run, aggregate failures also include infrastructure outcomes; a lower `failureRateDelta` is not a verification verdict.

Compare an actual matching baseline trial with an actual clean candidate trial. Replace the placeholders below with the returned IDs and observed indices, without angle brackets:

```sh
failtrace compare <baseline-run> <candidate-run> --trial-a <matching-baseline-index> --trial-b <clean-candidate-index> --json
```

The two-run default selects the first trial of each run, which may not show the relevant failure. Comparison reports output differences, aggregate rates and recorded setting differences; it does not validate the whole experiment, compare every setting, or decide whether the fix worked. Inspect full trial evidence through Core `loadRun`, or the returned JSON and individual result files; a sampled MCP trial list is not a complete denominator. Selected environment snapshots do not capture all runtime state.

For agents using a package without Verify, call `failtrace_run` twice and `failtrace_compare` with `runA`, `runB`, `trialA` and `trialB`. Reuse the exact predicate object and time budget; the caller must perform the checks above.

A suitable report is: "The target matched 14/50 valid baseline trials and 0/50 valid candidate trials under the recorded conditions. All candidate commands exited successfully. The target was not observed in that candidate sample; elimination and statistical improvement have not been established." The counts here illustrate wording, not a measured FailTrace case.

The [Prettier investigation](../examples/cases/prettier-chain/investigate.mjs) uses an affected version, a fixed control, actual successful exit checks and a reduced-input recheck. Its version-specific commands are an intentional intervention. Its manual checks illustrate the same requirement to separate the intended defect from unrelated parser errors.

## Evidence requirements enforced by Core

The operation enforces evidence quality and reports observations. It provides no automatic "fixed" or "strong improvement" verdict.

| Area | Behavior |
| --- | --- |
| Baseline eligibility | Load versioned evidence; require an ordinary full-budget, clean run with explicit target matches and a known predicate. Reject missing/ambiguous legacy match data, partial runs and threshold-stopped frequency baselines. Offer a fresh baseline when evidence is unsuitable. |
| Target selection | Require the caller's explicit current command and working directory; saved metadata alone is not authority to run arbitrary code. Carry over the baseline predicate and sampling settings, with candidate budget chosen before execution. |
| Context | Opt-in snapshots preserve declared file hashes, bounded Git/source identity and selected runtime/environment settings. Ordinary runs without `captureContext` are not eligible. Missing evidence is unknown, not equal or unset. |
| Comparability | Detect recorded predicate, timeout, concurrency, command and relevant context changes. Intentional interventions must be explicit and appear in the report; unexplained mismatches cannot support a fix claim. |
| Execution health | Separate target matches from infrastructure problems and unrelated nonmatching failures. A declared healthy-completion policy defaults to exit 0 for nonmatches; a target that legitimately succeeds with another code needs an explicit policy. |
| Sampling | Begin with fixed budgets and no decision stopping. Never count unstarted/canceled/invalid trials as successful observations. Preserve partial evidence on cancellation. |
| Result | Link both run IDs, the sampling plan, observed target counts, unhealthy observations and relevant changes in one durable report. Return observational outcomes, never an elimination claim. |
| Adapters | CLI/JSON and MCP expose the Core operation and its cancellation semantics. Existing MCP operations stay available. |

Zero target matches with no valid baseline, a setup error or an incomplete run must not become a successful verification. Reproducing the original failure is a counterexample to elimination, although a patch might still reduce its rate. Observation and improvement are different questions.

## Statistical limits and later work

Confidence intervals require a sampling model. For a prechosen set of independent Bernoulli trials with a constant failure probability, an exact one-sided 95% upper bound after zero failures in 50 trials is `1 - 0.05^(1/50)`, about **5.82%**. This is an illustrative calculation, not functionality currently returned by FailTrace. The underlying exact binomial method is documented by [NIST](https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm).

Real repeated tests can share database state, seeds, services or resource contention, so those assumptions require justification. Two-sample improvement claims additionally need a specified comparison method and a meaningful effect threshold. Repeatedly peeking, choosing a favorable baseline or trying patches until one sample looks good also changes what can be inferred. Do not automatically label a result "strong evidence" from nonoverlapping point estimates or a zero numerator.

Bisect/minimize stop when a finite match threshold is decided; that is a different workload. A future counterexample-only check could stop on the first target match, but its observed rate would not be a full-budget estimate. Statistical early stopping needs a separately reviewed sequential procedure. Verify currently uses fixed budgets.

The release gate includes unchanged and fixed controls, a remaining target failure, nonmatching syntax/setup errors, context changes, ineligible baselines and cancellation. Package smoke checks exercise installed Core, CLI and MCP against a fixed control and unrelated-error guard. Independent use of this workflow, not the addition of a command name, is the adoption test.

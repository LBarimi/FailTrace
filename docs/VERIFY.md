# Verify a proposed fix

**Status: planned Core capability.** There is no `failtrace verify` command or `failtrace_verify` MCP tool today. This page separates a workflow available now from the requirements for that future operation. A minimization's `finalVerified` only says the reduced input still reproduces the defect; it does not verify a code fix.

## Available now: full runs before and after a change

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

For agents, use the existing `failtrace_run` twice and `failtrace_compare` with `runA`, `runB`, `trialA` and `trialB`. Reuse the exact predicate object and time budget. Do not ask for a nonexistent verification tool.

A suitable report is: "The target matched 14/50 valid baseline trials and 0/50 valid candidate trials under the recorded conditions. All candidate commands exited successfully. The target was not observed in that candidate sample; elimination and statistical improvement have not been established." The counts here illustrate wording, not a measured FailTrace case.

The [Prettier investigation](../examples/cases/prettier-chain/investigate.mjs) already uses an affected version, a fixed control, actual successful exit checks and a reduced-input recheck. Its version-specific commands are an intentional intervention. It is a useful example of this workflow, not an implementation of the planned generic operation.

## Planned Verify contract

The initial operation should enforce evidence quality and report observations. It should not add an automatic "fixed" or "strong improvement" verdict before a statistical method and its assumptions have been reviewed.

| Area | Required behavior before shipping |
| --- | --- |
| Baseline eligibility | Load versioned evidence; require an ordinary full-budget, clean run with explicit target matches and a known predicate. Reject missing/ambiguous legacy match data, partial runs and threshold-stopped frequency baselines. Offer a fresh baseline when evidence is unsuitable. |
| Target selection | Require the caller's explicit current command and working directory; saved metadata alone is not authority to run arbitrary code. Carry over the baseline predicate and sampling settings, with candidate budget chosen before execution. |
| Context | Preserve input identity and declared setup, revisions/patch identity and selected runtime/environment settings. Explain that ordinary current runs do not capture input hashes, all target runtimes or general Git provenance. Treat missing data as unknown, not equal or unset. |
| Comparability | Detect recorded predicate, timeout, concurrency, command and relevant context changes. Intentional interventions must be explicit and appear in the report; unexplained mismatches cannot support a fix claim. |
| Execution health | Separate target matches from infrastructure problems and unrelated nonmatching failures. A declared healthy-completion policy defaults to exit 0 for nonmatches; a target that legitimately succeeds with another code needs an explicit policy. |
| Sampling | Begin with fixed budgets and no decision stopping. Never count unstarted/canceled/invalid trials as successful observations. Preserve partial evidence on cancellation. |
| Result | Link both run IDs, the sampling plan, observed target counts, invalid observations and relevant changes in one durable report. Use observational outcomes such as target observed, target not observed, or inconclusive; exact schema/exit codes require review before release. |
| Adapters | Implement the contract in Core first; CLI/JSON and MCP expose that same operation and cancellation semantics. Existing MCP operations stay available. |

Zero target matches with no valid baseline, a setup error or an incomplete run must not become a successful verification. Reproducing the original failure is a counterexample to elimination, although a patch might still reduce its rate. Observation and improvement are different questions.

## Statistical limits and later work

Confidence intervals require a sampling model. For a prechosen set of independent Bernoulli trials with a constant failure probability, an exact one-sided 95% upper bound after zero failures in 50 trials is `1 - 0.05^(1/50)`, about **5.82%**. This is an illustrative calculation, not functionality currently returned by FailTrace. The underlying exact binomial method is documented by [NIST](https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm).

Real repeated tests can share database state, seeds, services or resource contention, so those assumptions require justification. Two-sample improvement claims additionally need a specified comparison method and a meaningful effect threshold. Repeatedly peeking, choosing a favorable baseline or trying patches until one sample looks good also changes what can be inferred. Do not automatically label a result "strong evidence" from nonoverlapping point estimates or a zero numerator.

Bisect/minimize stop when a finite match threshold is decided; that is a different workload. A future counterexample-only check could stop on the first target match, but its observed rate would not be a full-budget estimate. Statistical early stopping needs a separately reviewed sequential procedure; it is not a prerequisite for the first fixed-budget Verify operation.

Before release, validate at least an unchanged bug, a genuine fixed control, a rare remaining failure, a nonmatching syntax/setup error, changed predicate/input/settings, an early-stopped baseline and cancellation. Keep a real-project affected/fixed example and installed Core/CLI/MCP checks. Independent use of this workflow, not the addition of a command name, is the adoption test.

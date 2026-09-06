# Did the intended check run?

**Added in 1.2.0.** See the [README](../README.md#availability-and-contributing) for publication status. Keep a supporting version when recording, inspecting and verifying checkpoint-enabled evidence; 1.1.0 and older readers do not enforce this condition. The example below uses a source build.

A command can exit successfully because a test was skipped, no matching tests were selected, or an early return bypassed the check. A missing failure signature alone cannot distinguish these cases from a useful candidate sample.

Select a second signal: a literal message that your target emits **after the intended check has run**, on both healthy and target-failing paths. FailTrace records it separately from the failure predicate and requires it in every classified trial. Do not print it from an unconditional shell wrapper or a `finally` block that also runs after setup errors.

## Try an original event-import example

The example imports revisions of entities. The affected implementation keeps the first revision of each ID and discards a newer revision later in the batch. An independent checker compares retained revisions with the expected latest ones. These are authored fixtures, not observations from an external project or production incident.

From the repository root, build and create a new disposable copy. The setup command refuses an existing destination.

```sh
npm ci
npm run build
node -e "const fs = require('node:fs'); fs.mkdirSync('.failtrace', {recursive:true}); const d = '.failtrace/event-import'; fs.mkdirSync(d); for (const f of ['check.mjs','importer.mjs','events.json']) fs.copyFileSync('examples/workflows/event-import/'+f, d+'/'+f);"
node dist/cli/index.js run "node check.mjs" --cwd .failtrace/event-import --repeat 5 --stderr-contains IMPORT_REVISION_LOST --require-stdout-contains IMPORT_CHECK_COMPLETED --context-input events.json --context-source check.mjs --context-source importer.mjs
```

The baseline records the target failure and the completed check. Exit `1` is expected. Keep its printed run ID. Apply the supplied fix to the disposable copy:

```sh
node -e "require('node:fs').copyFileSync('examples/workflows/event-import/importer-fixed.mjs','.failtrace/event-import/importer.mjs');"
node dist/cli/index.js verify <baseline-id> --command "node check.mjs" --cwd .failtrace/event-import --allow-change "source:retain the newest revision for each entity"
```

The corrected importer produces no target matches while the checker still emits its completion message: `target_not_observed`, exit `0`. The report preserves the changed source identity and inherited checkpoint.

Now test a misleading candidate that skips the checker, using the same original baseline ID:

```sh
node -e "require('node:fs').writeFileSync('.failtrace/event-import/check.mjs', 'process.exitCode = 0;');"
node dist/cli/index.js verify <baseline-id> --command "node check.mjs" --cwd .failtrace/event-import --allow-change "source:negative control that bypasses the check"
```

The command exits `0` and never prints the target error. Verify still reports `inconclusive`, exit `2`, because the required completion signal is absent. The next debugging step is to restore the intended check before judging the patch.

## CLI, Core and MCP

For `run`, `bisect` and `minimize`, choose at most one of:

```text
--require-stdout-contains CHECK_COMPLETED
--require-stderr-contains CHECK_COMPLETED
```

Core `runTrials`, `bisectRegression` and `minimizeFailure`, and their MCP tools, accept:

```json
{
  "executionRequirement": {
    "stream": "stdout",
    "contains": "CHECK_COMPLETED"
  }
}
```

The requirement is optional. It accepts 1 to 1,048,576 characters and uses streaming UTF-8 substring matching. It has no regular-expression mode. Choose a precise, stable message; command text, checkpoint text and output may contain private information and should be reviewed before sharing.

Run metadata records `executionRequirement`; each finished trial records `executionMatched`. A missing field in a checkpoint-enabled run is unknown evidence. Ordinary `status`, `failureMatched` and statistics continue to describe execution outcomes and the failure predicate separately. Use Core `assessRun` for classification. CLI `run` exits `2` for missing required evidence. MCP run responses additionally include `assessment` and a count of trials with missing execution evidence when the requirement is selected.

Verify inherits the baseline requirement. The candidate cannot override or drop it. Baseline eligibility checks the recorded field, and verification also confirms the checkpoint in saved output. Its `executionEvidenceMissingTrials` count identifies otherwise valid trials missing the checkpoint; infrastructure, invalid records and unrelated unhealthy exits retain their existing categories. Inspect `reasons` as well as counts.

Read-only inspection includes checkpoint fields and selects missing/unknown completion through `filter: "unhealthy"`. Compare prefers a completed healthy nonmatch and target match; explicitly choosing a trial with missing completion produces a warning. Bundles preserve the requirement in `repro.json` and replay enforces it with the included engine.

Bisect cannot classify a commit without the checkpoint. Minimization never accepts such a candidate; inconclusive candidates remain recorded and can make the overall reduction inconclusive even when its final reproducer is verified. Input validation failures may legitimately lack the checkpoint, so inspect the overall `status`, candidate evidence and `finalVerified` separately.

## What this establishes

The checkpoint establishes that selected text was observed in a clean, fully captured trial. Timeouts, signals, output truncation and write errors cannot establish completion even if an earlier output chunk contained the text. Ordinary repetition still attempts its full budget; threshold experiments stop without a decision when required evidence is missing.

This is not coverage instrumentation, proof that the target's checker is correct, statistical confidence, or proof that a bug was eliminated. A wrongly placed or misleading marker can still produce misleading evidence. Keep input, setup and source declarations meaningful, emit the signal at the real completion point, and retain the captured baseline before editing.

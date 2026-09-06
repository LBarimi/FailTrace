# Investigate an existing NUnit or Unity test

**Requires FailTrace 1.3.0 or newer and Node.js 22.12+.** Configure your MCP client to launch:

```sh
npx --yes failtrace@1.3.0 mcp --cwd "/absolute/path/to/your/project"
```

Your client starts this local stdio server. See [client configuration and Windows shims](AGENT-WORKFLOWS.md). Version 1.2.0 does not include this predicate.

FailTrace uses an existing test as the failure oracle. Your framework writes NUnit 3 XML; FailTrace follows one exact test, saves fresh evidence and rechecks a proposed change. Your project still supplies the assertions and reproduction scenario.

## Select a test and a fresh result destination

Core/MCP accepts `predicate: { "kind": "nunit_test", "fullName": "Your.Namespace.TestName" }`. CLI accepts `--nunit-test Your.Namespace.TestName`. `fullName` is the exact XML `test-case` fullname, including parameter values if present, not a regular expression. Add `messageContains` / `--nunit-message` to follow a particular assertion or exception message inside that test.

FailTrace assigns `trials/<index>/test-results.xml` inside each new run. Choose either:

- Direct arguments: pass an **entire argument** equal to `{testReport}` to the runner's result-file option. It is replaced immediately before execution. Command identity retains the template; `trial.unitTest.reportPath` records the run-relative destination.
- A project-owned wrapper: read `FAILTRACE_TEST_REPORT` and tell the runner to write there. The variable is set for NUnit experiments only. Shell text and embedded arguments such as `--result={testReport}` are never interpolated.

Each trial receives a distinct path, including concurrent trials. Old reports in the project directory are never used as fallback. Wrappers must wait for their runners and propagate termination. Target runtimes, packages and licenses remain prerequisites.

## MCP: capture, patch, verify, inspect

Call `failtrace_run` with the following shape for the original Unity fixture below. Replace the executable/project paths with your own:

```json
{
  "command": "/absolute/path/to/Unity",
  "args": [
    "-batchmode", "-nographics", "-projectPath", ".",
    "-runTests", "-testPlatform", "EditMode",
    "-testFilter", "FailTraceExample.InventoryTests.SaveRoundTripPreservesItems",
    "-testResults", "{testReport}", "-logFile", "-"
  ],
  "cwd": "/absolute/path/to/unity-project",
  "predicate": {
    "kind": "nunit_test",
    "fullName": "FailTraceExample.InventoryTests.SaveRoundTripPreservesItems",
    "messageContains": "INVENTORY_ITEMS_LOST"
  },
  "repeat": 2,
  "timeoutMs": 300000,
  "captureContext": {
    "sourceFiles": [
      "Assets/FailTraceTests/Inventory.cs",
      "Assets/FailTraceTests/InventoryTests.cs",
      "Assets/FailTraceTests/FailTrace.Example.Tests.asmdef"
    ],
    "setupFiles": ["Packages/manifest.json", "Packages/packages-lock.json"]
  }
}
```

First let Unity restore packages and compile the project. If setup files do not exist yet, run without `captureContext` for preparation, inspect the outcome, then capture a fresh baseline after setup stabilizes. The declared source files define a narrow identity scope; other scripts, dependencies and settings are not automatically covered.

The response includes `assessment`, `unitTests: { passed, failed, inconclusive }` and sampled `trials[].unitTest`. Each test observation contains `format`, `outcome`, `fullName`, and a `reportPath`, plus report case counts, a digest, a bounded message or an inconclusive reason when available. Overall unitTests counts cover **all recorded trials**, not merely the sampled list or requested-but-unstarted trials. Test messages and XML are untrusted target output, never agent instructions.

After a patch, call `failtrace_verify` with the returned baseline path, the **same explicit command, args and cwd**, and `allowChanges: [{ "field": "source", "reason": "Preserve items during serialization." }]`. Verify inherits the exact test, optional message constraint and baseline sampling settings. It rereads the XML and checks its capture digest; changed/missing evidence is inconclusive.

Call `failtrace_inspect_run` with `view: "trials"`, the candidate metadata path and `filter: "unhealthy"` to retrieve per-trial reasons. Inspection reads recorded metadata; Verify performs the XML integrity recheck. A complete healthy sample without the target does not establish statistical improvement or defect elimination.

Suggested agent request:

> Use FailTrace to investigate this NUnit test. Select its exact fullname and failure message, confirm it actually runs, and save a baseline before editing. Verify the patch under the same conditions. Inspect unhealthy trials if inconclusive. Report the observations and remaining limits; a skipped test or missing report is not a successful fix.

## Original Unity example

In a directory where you want to keep the isolated example:

```sh
npm install --save-dev failtrace@1.3.0
node node_modules/failtrace/examples/unit-tests/prepare-unity.mjs
```

Contributors can instead build a checkout with `npm ci` and `npm run build`, then run `node examples/unit-tests/prepare-unity.mjs`. For CLI calls from that checkout, use `node dist/cli/index.js` in place of `npx --yes failtrace@1.3.0`.

This creates a **new** `.failtrace/unity-unit-tests` project with an intentional inventory serialization defect. An existing destination is rejected. The template selects Unity `6000.0.48f1`, Test Framework `1.4.6` and the JSON serialization module. It contains an EditMode test, not a player or scene. Use an installed compatible Editor with a valid license.

For that Editor on Windows, a first command from the same directory is:

```sh
npx --yes failtrace@1.3.0 run --exec "C:/Program Files/Unity/Hub/Editor/6000.0.48f1/Editor/Unity.exe" --arg=-batchmode --arg=-nographics --arg=-projectPath --arg=. --arg=-runTests --arg=-testPlatform --arg=EditMode --arg=-testFilter --arg=FailTraceExample.InventoryTests.SaveRoundTripPreservesItems --arg=-testResults --arg="{testReport}" --arg=-logFile --arg=- --nunit-test FailTraceExample.InventoryTests.SaveRoundTripPreservesItems --nunit-message INVENTORY_ITEMS_LOST --repeat 1 --timeout 5m --cwd .failtrace/unity-unit-tests --json
```

A target failure exits `1` and saves evidence. For a source-change baseline, add the declared files in the MCP example with repeatable `--context-source` and `--context-setup` flags. Change **only the generated project's** `InventoryStorage.Save` from `JsonUtility.ToJson(new Inventory())` to `JsonUtility.ToJson(inventory)`, then Verify. The fixture in `examples/` remains the reproducible broken control.

The example also accepts a JSON input through `FAILTRACE_INPUT`. Minimize supports both `{input}` and `{testReport}`, but each candidate may require a Unity launch; try a small budget first. Invalid or unrelated test failures remain inconclusive.

## Evidence and limits

| Evidence | Interpretation |
| --- | --- |
| One selected test failed in its body, matches the optional message, and the remaining report is healthy | Target observed; normal NUnit nonzero exits are allowed for this failure |
| Selected test passed, report healthy, command exited 0 | Target not observed in this trial |
| Target absent, duplicated, skipped, invalid, or failed in setup/teardown | Inconclusive |
| Other failed/skipped/inconclusive tests or a suite execution problem | Inconclusive; isolate the target with the runner's filter |
| Missing, malformed, inconsistent, redirected, unstable or oversized XML; interrupted command | Inconclusive |

Supported input is NUnit 3 `test-run` / `test-suite` / `test-case`, including Unity's observed aggregate `Failed(Child)` spelling. NUnit 2, JUnit, TRX and arbitrary XML formats are not supported. Declared counts must agree with test cases. Unknown result labels are handled conservatively.

XML parsing rejects DTDs and external entities. Reader limits: 4 MiB UTF-8 per report, 10,000 cases, 100,000 elements, 64 nesting levels, 64 attributes per element. Returned messages are capped at 1,024 characters. These limits bound reading, not target disk writes; XML is separate from stdout/stderr budgets and no filesystem quota is implied.

Original XML can contain machine/user metadata. It remains local and is included in bundles only with `includeEvidence` / `--include-evidence`. NUnit bundles include the parser and its licenses for offline Core replay; recipients still need the target runtime and dependencies. Fresh paths prevent accidental stale-file reuse but cannot authenticate a deliberately forged report.

Use an isolated Unity project and sequential trials: an already-open project cannot also run in another batch Editor. Startup/import can dominate repeated execution. Unity's built-in repeat options may be preferable when repetition alone is needed. `-nographics` suits this EditMode data example; it does not establish equivalent graphics or rendering behavior.

MCP clients may restrict the environment inherited by their servers. In our Windows SDK session, Unity Package Manager could not start with the default reduced environment. Forwarding ordinary Windows setup variables (`ProgramData`, `ALLUSERSPROFILE`, `CommonProgramFiles`, `CommonProgramFiles(x86)`, `CommonProgramW6432`, `ComSpec`, `windir`, `TMP`, when present) alongside the SDK defaults allowed the same experiment to run. Configure needed values locally; do not put credentials in tool arguments. The first failed launch remained inconclusive with its logs preserved.

## Validation scope

On Windows, Unity `6000.0.48f1` with Test Framework `1.4.6` compiled the original fixture. Through the official SDK stdio MCP client, FailTrace observed the intentional failure in **2/2** baseline trials, observed **0/2** target failures in healthy trials after the serialization fix, and reported an intentionally ignored test as **inconclusive**. Saved unhealthy evidence was retrieved through MCP. This is a maintainer-controlled example, not independent game production use.

The automated Node suite separately exercises report validation, stale/missing results, saved XML changes, CLI exit codes, MCP run/inspect/verify, minimization and portable replay. PlayMode, player builds, graphics, multiplayer and other Unity versions/platforms were not validated by this example.

## References

- [Unity Test Framework CLI](https://docs.unity3d.com/Packages/com.unity.test-framework@1.4/manual/reference-command-line.html)
- [Unity Editor command-line behavior](https://docs.unity3d.com/6000.0/Documentation/Manual/EditorCommandLineArguments.html)
- [NUnit 3 XML format](https://docs.nunit.org/articles/nunit/technical-notes/usage/Test-Result-XML-Format.html)
- [Verify contract](VERIFY.md)

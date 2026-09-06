# Set up once, repeat the investigation

The baseline command has several settings worth keeping: the target signature, trial budget, timeout and files that define the experiment. Put those settings in an inspectable project script so the next investigation starts with the same conditions.

The following pattern works with **published 1.3.0** and an existing npm project. It does not require a new FailTrace configuration format or background service. For other projects, use the same explicit commands in the project's existing task runner.

## Name the two actions

Install and pin FailTrace in the project:

```sh
npm install --save-dev failtrace@1.3.0
```

Merge these entries into the existing `scripts` object in `package.json`. Replace the target command, signature and file paths with the actual ones from your project; each context path must identify an existing regular file.

```json
{
  "debug:baseline": "failtrace run \"npm test -- checkout\" --repeat 10 --timeout 30s --stderr-contains \"checkout failed\" --context-input cases.json --context-setup package.json --context-setup package-lock.json --context-source src/checkout.js --context-source test/checkout.test.js",
  "debug:verify": "failtrace verify --command \"npm test -- checkout\" --cwd . --allow-change \"source:check the proposed checkout fix\""
}
```

The target command is repeated explicitly in both actions. The configuration remains visible in your own project, and saving or reading it does not run anything. Include the test itself in source context so removing or changing it becomes a visible intervention. Include other input, source and setup files relevant to this particular check. A files-only declaration does not automatically cover the rest of the repository.

Before editing code:

```sh
npm run debug:baseline
```

Keep the returned run ID. Exit `1` is expected when the selected failure is reproduced. If the expected signature never appears, correct the command or predicate before calling that run a baseline. Avoid putting baseline capture on the left of `&&`: its expected failure exit would stop the next command.

After making the proposed change:

```sh
npm run debug:verify -- <baseline-id>
```

Verify inherits the original predicate, declared context and execution settings. It reports changed conditions and the reason supplied by the script. The example permits source changes; a dependency change may also need an explicit `setup` allowance. Do not edit the captured setup or verification script after the baseline just to make a candidate pass. Use the result's `reasons` and `changes` to decide whether a new baseline is required.

## Automation and agents

For one JSON result without npm's normal presentation:

```sh
npm run --silent debug:baseline -- --json
npm run --silent debug:verify -- <baseline-id> --json
```

Preserve the exit code as well as the JSON. `target_observed`, `target_not_observed`, `inconclusive` and `interrupted` have different meanings; a nonzero exit is not automatically a broken integration. See the [result contract](VERIFY.md).

An agent with a shell can read and invoke these named actions. An MCP agent can instead call `failtrace_run` with the same target command and explicit settings, then `failtrace_verify` with the returned baseline, current command and working directory. Do not wrap `debug:baseline` inside `failtrace_run`; that would start one FailTrace experiment inside another. Use the [MCP guide](AGENT-WORKFLOWS.md) for the tool inputs.

## Keep experiments comparable

- Choose a target-specific signature. A dependency installation error should not become the failure you are measuring.
- Use an existing project reset/setup wrapper when the command mutates external state. Shell repetition does not reset files, services or databases.
- Use explicit baselines instead of an automatically selected "latest" result. A previous investigation may belong to a different input or source state.
- Review captured environment keys deliberately; never place tokens or private environment values in the script for convenience.

**Since 1.2.0:** add `--require-stdout-contains CHECK_COMPLETED` (or the stderr form) to baseline capture when the target emits that message after the intended check. Verify inherits it. The option is unavailable in 1.1.0; see the [execution checkpoint guide](EXECUTION-EVIDENCE.md). Without it, a normal exit alone does not establish that the intended test ran.

The installed-package checks exercise this script pattern from a fresh consumer, including an expected failing baseline, an unchanged-bug control and a healthy fixed candidate. This validates the command path; the setup effort and usefulness for independent users still need voluntary observation.

[Documentation index](README.md)

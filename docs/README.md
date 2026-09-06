# FailTrace documentation

Choose the task you want to finish. You do not need to read every guide in order.

| Start here | Result |
| --- | --- |
| [Install and run the demo](INSTALL.md) | Try a complete original example, then choose a project or global install. |
| [Connect a coding agent](AGENT-WORKFLOWS.md) | Configure MCP, run a connection check, and inspect returned evidence. |
| [Investigate your own command](PROJECT-WORKFLOW.md) | Save repeatable baseline and verification actions in your project. |
| [Recheck an existing unit test](UNIT-TESTS.md) | Follow one NUnit test through a failure, a patch, and a skipped-test control. |
| [Explore original examples](WORKFLOWS.md) | Reduce data-import and asynchronous-update failures and check their fixes. |

## Continue an investigation

| Task | Guide |
| --- | --- |
| Choose a failure signature or find an option | [CLI reference](CLI.md) |
| Pass executable arguments without shell parsing | [Direct execution](DIRECT-EXECUTION.md) |
| Compare a proposed change with a saved baseline | [Verify](VERIFY.md) |
| Require evidence that a check actually ran | [Execution checkpoints](EXECUTION-EVIDENCE.md) |
| Package and replay selected evidence | [Bundles](BUNDLES.md) |
| Inspect accumulated evidence storage | [Storage inventory](ARTIFACTS.md) |
| Understand the README animation and its controls | [Guided demo](DEMO.md) |

## Reference

- **Result interpretation:** [CLI outcomes and exit codes](CLI.md#artifacts-and-exit-codes), [Verify verdicts](VERIFY.md), and [resource limits](RESOURCE-LIMITS.md).
- **Compatibility:** [1.x contract](COMPATIBILITY.md) and [migration from 0.x](MIGRATING-TO-1.md).
- **Performance:** [scope and costs](PERFORMANCE.md) and [benchmark method](BENCHMARKS.md). Measurements describe their workloads and environments.
- **Development:** [contributing](../CONTRIBUTING.md), [implementation](IMPLEMENTATION.md), [release procedure](RELEASING.md), and [release validation records](RELEASE-VALIDATION.md).
- **Direction:** [roadmap](ROADMAP.md), [adoption priorities](ADOPTION.md), and [optional workflow observations](WORKFLOW-OBSERVATION.md).

Install examples use the published version. Features marked **Unreleased** require a source build and are not available from those package commands yet.

[Back to FailTrace](../README.md)

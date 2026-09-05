# Product direction and roadmap

FailTrace helps developers and coding agents turn a difficult failure into repeatable experiments, a smaller reproducer and inspectable evidence after a proposed change. Success means useful independent use and repeat use, as described in the [adoption goal](ADOPTION.md).

## Capability priorities and current state

**Predicate → Compare → Bisect → Minimize → Verify → Bundle → MCP**

This expresses product emphasis. An investigation can use just the operations it needs; a small defect may need only a baseline and verification. MCP exposes the same Core engine and remains supported.

| Capability | Published 1.1.0 | Next emphasis |
| --- | --- | --- |
| Predicate | Nonzero/exact exit, stdout/stderr substring and regex | Separate the intended defect from execution problems |
| Compare | Saved outputs, hashes, statistics, selected environment and interpretation warnings | Help callers choose comparable evidence |
| Bisect | Repeated first-parent classification in an isolated worktree with explicit exit policies | Preserve inconclusive outcomes and source evidence |
| Minimize | Text, JSON, files and environment keys, with a separate final recheck | Preserve the target and make candidate-input setup easier |
| Verify | Baseline eligibility, declared context, fixed-budget sampling and linked evidence | Distinguish valid execution from skipped or incomplete checks |
| Bundle | Selected source/input, replay engine, sharing choices and content manifest | Preserve useful reproduction context and explicit sharing scope |
| MCP | Seven tools, including bounded read-only saved-run inspection | Keep complete counts and interpretation aligned with Core |

The original milestones are implemented. Their completion is not an adoption metric. See the [compatibility contract](COMPATIBILITY.md), [command reference](CLI.md) and [performance scope](PERFORMANCE.md).

## Unreleased source improvements

The source checkout supports [execution checkpoints](EXECUTION-EVIDENCE.md). A baseline can require a message emitted after the intended check has run. Verify inherits it and reports an inconclusive result when a candidate silently skips that check. Core, CLI, MCP, saved inspection, comparison, classification and replay preserve the condition. Published 1.1.0 does not include this option.

Original authored workflow fixtures exercise affected implementations, valid fixes and misleading candidate controls. They demonstrate how evidence changes a debugging decision; they are not production incident reports or evidence of external adoption.

[Named project actions](PROJECT-WORKFLOW.md) keep repeated baseline/verification settings inspectable using existing project scripts. The unreleased [storage inventory](ARTIFACTS.md) shows bounded totals and observed evidence references. It does not delete records or infer inactivity from their age.

## Next priorities

- Observe whether named project actions reduce repeated setup for commands, signatures and baseline context; improve the steps that cause actual friction.
- Keep storage operations bounded and reviewable. Automatic deletion needs a separate ownership and active-access contract; legacy paths and reported states do not supply one. Require evidence of user need before adding that broader protocol.
- Preserve OS/Node, installed-package, replay and performance gates. Record local-only validation accurately while publication is pending.
- Collect voluntary observations of time to first useful result, interpretation errors and second use. Let those observations determine further features.

## Boundaries

Statistical uncertainty requires a defined sampling plan. Sequential trials are not automatically independent, and zero observed failures do not prove elimination. Bisect/minimize stopping rules establish sampled threshold decisions.

Output, input copies, input complexity and metadata are bounded; see [resource limits](RESOURCE-LIMITS.md). Target services, dependency setup and state reset remain the caller's responsibility. Concurrency changes resource contention and may change failure behavior.

Core stays independent of CLI/MCP, AI providers and cloud services. No hosted service, accounts or telemetry are needed. Additional predicate modes, environment matrices and reducers require evidence of a useful debugging problem before implementation.

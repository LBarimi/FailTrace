# Adoption is the product goal

FailTrace should become a local debugging primitive that humans and coding agents reach for when a failure is hard to reproduce. Success means independent developers installing it, obtaining useful evidence, and returning to it on their own code.

## Product decisions

Before a major feature, ask: **Will this make significantly more developers or AI agents want to use FailTrace?**

Prefer a recognizable debugging problem, a demonstrable result, easier integration, and less repeated manual work. Keep the identity focused on reproduction, regression isolation, input reduction, fix verification and transferable evidence. Feature count, downloads, stars and passing tests do not establish useful repeated adoption.

## What is verified

The [release validation records](RELEASE-VALIDATION.md) cover package installation, CLI/Core/MCP checks, original workflows and replay. The [unit-test guide](UNIT-TESTS.md) records the controlled EditMode integration scope. These checks establish functionality and distribution integrity.

## What remains unknown

Independent active users, recurring agent use, useful integrations and retention have not been established. No performance result or scripted SDK session should be relabeled as evidence of those outcomes. A server's availability does not show that an agent selected it unprompted or that its result helped solve a bug.

The initial inspection on 2026-09-04 found zero stars and forks before distribution. That dated observation is not a current user count.

## Current priorities

The 1.3.0 [NUnit/Unity integration](UNIT-TESTS.md) addresses the requested workflow of checking an existing game unit test through an agent. A maintainer-controlled Unity EditMode example exercises a failing baseline, a source fix and a skipped-test negative control over MCP. This establishes a working integration in the documented environment, not independent adoption or a production performance claim.

1. **Shorten time to useful evidence.** Help a developer connect an existing command, select a meaningful target, capture a baseline and interpret the next result. Keep saved commands and context inspectable.
2. **Preserve the meaning of a check.** Distinguish target matches, skipped execution, unrelated failures and incomplete evidence. Make useful negative controls easy to run.
3. **Support repeated use.** Make evidence easy to find and inspect; bound storage and cleanup operations without losing active or referenced work.
4. **Measure relevant costs.** Use versioned, bounded workloads with explicit limitations. Preserve raw local evidence privately and publish only reviewed aggregates.
5. **Observe independent workflows.** Use voluntary reports to learn whether evidence changed a debugging decision and whether a person or agent returned. No outreach or automatic data collection is implied.

## Evidence to collect

Use the [voluntary debugging-session guide](WORKFLOW-OBSERVATION.md) to record time to useful evidence, help needed, agent tool choices and observed second use. It is an observation plan; no independent sessions or usage gains are implied by its existence.

| Question | Useful evidence | Interpretation limit |
| --- | --- | --- |
| Can a new user get value? | Fresh-directory installation and a voluntary report of time to first result | Maintainer checks establish functionality |
| Does it help with the user's own failure? | A report of the selected command, evidence and resulting next step | Reports are self-selected; private logs are optional |
| Do agents select it effectively? | Opt-in session records showing tool choice and how evidence informed the fix | A scripted SDK test establishes compatibility |
| Does usage repeat? | Voluntary follow-up reports and recurring integrations | Downloads and stars do not identify active users |
| Is adoption improving? | Dated, attributable observations using the same definitions | Small samples cannot establish broad adoption |

No runtime telemetry, account requirement, unsolicited outreach or automatic data collection is part of this plan. Keep claims tied to inspectable evidence and adjust priorities when users show a different bottleneck.

[Documentation index](README.md)

# Observe a useful debugging session

The next adoption question is whether someone can use FailTrace on their own failure, get evidence that changes their next step, and choose it again. An installation check, a guided demo, or an MCP handshake does not answer that question.

Use this short guide with a willing participant. No telemetry, account, company name, private source, or raw logs are needed. Start with three to five voluntary sessions to identify recurring friction; that sample cannot establish a market-wide success rate. This guide does not authorize contacting people or publishing their reports.

## Before the session

- Choose a real unresolved command failure from a project the participant can investigate. Use a disposable working copy if the target changes files or external state.
- Record the FailTrace version, OS, Node version, and CLI or agent client. Keep public-package checks separate from unreleased-source checks.
- Ask what the participant would normally do next without FailTrace. Let them describe the desired evidence before suggesting commands.
- Agree on a time box, such as 30 minutes, and an execution budget suitable for the target. Note any help supplied by a maintainer.

Start from the [README](../README.md#quick-start), [installation guide](INSTALL.md), or [agent setup](AGENT-WORKFLOWS.md). The built-in demo is an orientation option; completion on its own is not a useful result on the participant's problem.

## What to observe

| Step | Record | What to check |
| --- | --- | --- |
| Find and install | First command, elapsed time, errors, help needed | Can they start without a source build or hidden setup? |
| Define the failure | Intended signature and chosen predicate | Does it track the original failure rather than any nonzero exit? |
| Run a bounded sample | Requested/completed trials, target matches, unhealthy outcomes | Is the result sufficient for the next decision, or is it inconclusive? |
| Inspect the evidence | Selected trial indices and why they were selected | Are they comparing a healthy attempt with the actual target failure? In 1.0.0, select indices explicitly if the default picked an unrelated failure. |
| Continue only when useful | Bisect, Minimize, Verify, or Bundle and its purpose | Do not require every feature. Capture Verify context before editing; distinguish no target observed from proof of a fix. |
| Decide the next step | What changed because of the evidence | A blocker or a decision to use another tool is also informative. |

Measure time to the first result that influenced a debugging decision, and separately note active user time if practical. A command finishing successfully is not enough. If the time box ends first, record that outcome and the blocker rather than inventing a completion time.

## When a coding agent is involved

Record whether the agent selected FailTrace itself, followed an explicit request to use it, or received step-by-step commands. These establish different things. Preserve only the tool choices and result excerpts needed to understand the decision, with the participant's agreement.

Look for concrete behavior: a predicate selected before sampling, saved logs inspected instead of rerunning unnecessarily, a baseline captured before editing, and uncertainty preserved after incomplete or unrelated failures. Note any human correction of an unsupported "fixed" claim. Do not treat an SDK script as an autonomous agent session.

For an initial prompted session, the [README's investigation prompt](../README.md#for-coding-agents) is sufficient. A later unprompted task can help assess discovery. A few sessions cannot establish that MCP causes fewer reasoning errors; that claim would need comparable tasks and repeated controlled observations.

## Record a small result

Keep a private note or voluntarily submit the existing [workflow issue form](https://github.com/LBarimi/FailTrace/issues/new?template=workflow.yml). An anonymous session label is enough:

```text
Session label and date:
FailTrace version / OS / Node / CLI or agent:
Original problem and usual next step:
How FailTrace was introduced (self-selected / prompted / guided):
First useful evidence and elapsed time, or blocker at time limit:
Commands or tool names used, with private details omitted:
Decision changed by the evidence:
Help or corrections needed:
Second use on another problem (observed / not observed / not yet known):
```

Ask about a second use after an agreed interval, for example two weeks, only if the participant wants a follow-up. Distinguish an intention to use it again from an observed second use. Lack of a report does not establish abandonment. Keep private transcripts and machine-specific output out of Git; any public excerpt needs a separate privacy review and the participant's agreement.

## Turn observations into work

Group repeated blockers by the step they prevented. Prefer the smallest change that removes a demonstrated barrier: installation, predicate choice, evidence inspection, patch verification, or sharing. Recheck the affected step in a later willing session. Do not infer feature demand from a single suggestion or choose an arbitrary conversion threshold as proof of adoption.

[Adoption priorities and evidence limits](ADOPTION.md)

[Documentation index](README.md)

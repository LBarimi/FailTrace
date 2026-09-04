# Adoption is the product goal

FailTrace should become a local debugging primitive that humans and coding agents reach for when a failure is hard to reproduce. Success means independent developers installing it, obtaining useful evidence, and returning to it in real projects. Feature count, a completed roadmap, and passing tests do not establish that outcome.

## Product decisions

Before a major feature, ask: **Will this make significantly more developers or AI agents want to use FailTrace?**

Prefer work that solves a recognizable debugging problem, replaces repetitive experiments that agents handle inefficiently, produces a demonstrable result, can be explained in seconds, and makes integration easier. Keep the identity focused on reproduction, regression isolation, input reduction, and transferable evidence. Avoid monetization, hype-driven scope, and functionality without a plausible user.

## Baseline — 2026-09-04

The initial public-state inspection found 0 GitHub stars, 0 forks, no releases, and no published `failtrace` package in the npm registry. These are dated distribution/discovery observations, not a count of users. Actual independent usage and retention are unknown.

Source revision `d0e2164` implemented the six initial milestones, but first use required cloning, installing, building, linking, and running the example from the source directory. MCP setup documented a generic configuration without client-specific workflows. There was no contributor guide or structured way to report a real use case.

## Distribution evidence — 2026-09-04

[v0.3.0](https://github.com/LBarimi/FailTrace/releases/tag/v0.3.0) provides a compiled package and checksum from commit `823163a`. Its [CI run](https://github.com/LBarimi/FailTrace/actions/runs/33883716383) passed 191 tests and installed-package checks across six OS/Node combinations. Maintainer verification downloaded the public asset without authentication, installed it with a fresh npm cache outside the source checkout, ran the demo, and replayed the resulting failure bundle. The installed MCP server exposed all five tools and reproduced a predicate-matching failure.

That public-install check caught npm 12's default restriction on URL packages; the instructions now include a command-scoped `--allow-remote=root` option. These results establish distribution and compatibility. They do not establish independent adoption. Registry publication and real-project usage evidence remain priorities.

The [Prettier case](../examples/cases/prettier-chain/README.md) applies the published FailTrace package to an upstream historical formatting defect. A maintainer run reduced authored surrounding context from 464 to 11 characters, verified the affected release still failed, and verified the fixed release actually exited successfully. The case supplies pinned dependencies, an explicit predicate, a replay recipe, and an agent investigation prompt. This is evidence that the workflow applies to a real package, not evidence of external adoption.

## Current priorities

1. **Reach a first useful result quickly.** Provide a prebuilt, versioned package and a demo that runs from a fresh directory, records real failures, minimizes real input, and creates a replayable bundle. Verify the advertised installation command against the published artifact.
2. **Let agents use the existing engine well.** Provide accurate Codex, Claude Code, and Cursor connection instructions, bounded example investigations, explicit predicates, and result checks. Explain when an agent should select each operation.
3. **Make real usage observable without telemetry.** Invite voluntary workflow reports, reproducible bugs, and integration contributions. Include first-install friction, what evidence helped, and whether the user returned to the tool. Keep reports optional; private logs are not required.
4. **Validate differentiation on real projects.** Reproduce public, safely runnable failure cases in disposable checkouts, record commands and limitations, and publish reproducible examples. Do not claim endorsement or integration by another project without evidence.
5. **Improve distribution using demonstrated results.** Prepare factual release notes and shareable demos. Outreach, posts, and messages to other maintainers require explicit user authorization. Do not manufacture stars, testimonials, downloads, or issues.

## Evidence to collect

| Question | Useful evidence | Interpretation limit |
| --- | --- | --- |
| Can a new user get value? | Fresh-directory install and demo; voluntary reports of time to first result | Maintainer smoke tests establish functionality, not adoption |
| Do developers use it on their own code? | Independent reports with a command, result, and optional public project link | Reports are self-selected |
| Do agents select it effectively? | Opt-in workflow transcripts showing tool choice and useful evidence | A hand-scripted SDK test is compatibility evidence only |
| Does usage repeat? | Follow-up reports, recurring integrations, external fixes and contributors | Downloads and stars are weak proxies |
| Is discovery improving? | Dated stars, forks, release asset downloads, referring integrations | Counters do not identify people or prove active use |

No runtime telemetry, account requirement, or automatic data collection is part of this plan. Keep claims tied to dated, inspectable evidence and adjust priorities when actual users show a different bottleneck.

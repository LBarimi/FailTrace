# Adoption is the product goal

FailTrace should become a local debugging primitive that humans and coding agents reach for when a failure is hard to reproduce. Success means independent developers installing it, obtaining useful evidence, and returning to it in real projects. Feature count, a completed roadmap, and passing tests do not establish that outcome.

## Product decisions

Before a major feature, ask: **Will this make significantly more developers or AI agents want to use FailTrace?**

Prefer work that solves a recognizable debugging problem, replaces repetitive experiments that agents handle inefficiently, produces a demonstrable result, can be explained in seconds, and makes integration easier. Keep the identity focused on reproduction, regression isolation, input reduction, and transferable evidence. Avoid monetization, hype-driven scope, and functionality without a plausible user.

## Baseline — 2026-09-04

The initial public-state inspection preceded the first release and registry distribution; it found 0 GitHub stars and 0 forks. These are dated distribution/discovery observations, not a count of users. Actual independent usage and retention are unknown.

Source revision `d0e2164` implemented the six initial milestones, but first use required cloning, installing, building, linking, and running the example from the source directory. MCP setup documented a generic configuration without client-specific workflows. There was no contributor guide or structured way to report a real use case.

## Distribution evidence — 2026-09-04

[v0.3.0](https://github.com/LBarimi/FailTrace/releases/tag/v0.3.0) provides a compiled package and checksum from commit `823163a`. Its [CI run](https://github.com/LBarimi/FailTrace/actions/runs/33883716383) passed 191 tests and installed-package checks across six OS/Node combinations. Maintainer verification downloaded the public asset without authentication, installed it with a fresh npm cache outside the source checkout, ran the demo, and replayed the resulting failure bundle. The installed MCP server exposed all five tools and reproduced a predicate-matching failure.

That public-install check caught npm 12's default restriction on URL packages; the GitHub archive alternative includes a command-scoped `--allow-remote=root` option. These results establish distribution and compatibility. They do not establish independent adoption. The registry route below removes the URL-specific installation step; real-project usage evidence remains a priority.

The [Prettier case](../examples/cases/prettier-chain/README.md) applies the published FailTrace package to an upstream historical formatting defect. A maintainer run reduced authored surrounding context from 464 to 11 characters, verified the affected release still failed, and verified the fixed release actually exited successfully. The case supplies pinned dependencies, an explicit predicate, a replay recipe, and an agent investigation prompt. This is evidence that the workflow applies to a real package, not evidence of external adoption.

## Registry distribution — 2026-09-05 (KST)

The primary installation routes are `npx --yes failtrace demo`, `npm install --global failtrace`, and `npm install --save-dev failtrace`. Normal registry installation needs no remote-archive option; the verified GitHub v0.5.0 package is the current archive alternative.

[failtrace 0.3.0](https://www.npmjs.com/package/failtrace/v/0.3.0) was published from the exact verified GitHub release archive (SHA-256 `c843f77e0b59a0137c1af1334d469db1fe12abe0cbfea377c1f87172730f79f4`). Unauthenticated registry downloads matched its SHA-512 integrity. A fresh npm cache, empty npm configuration, and an independent temporary project successfully ran `npx --yes failtrace demo`: 7 passes, 3 failures, six elements reduced to `["BUG"]`, and a replayed target match of 1 / 1. The installed CLI reported 0.3.0.

[FailTrace 0.3.1 is published on npm](https://www.npmjs.com/package/failtrace/v/0.3.1), and the [official MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.LBarimi%2Ffailtrace/versions/0.3.1) is active. These public name/version/status fields were checked on 2026-09-05. The release incorporates registry installation instructions, the documented Prettier case, exclusion of local case dependencies/evidence from package archives, and metadata for discovery of the existing MCP adapter. It adds no Core investigation features. Version 0.4.0 adds the [performance changes](PERFORMANCE.md); the dated distribution check above records the preceding release.

Publication, registration, and successful installation establish distribution and compatibility. They do not establish independent users, recurring agent use, or retention; those outcomes still need voluntary external evidence.

The [0.4.0 release](https://github.com/LBarimi/FailTrace/releases/tag/v0.4.0) ships the performance controls. Its reviewed archive SHA-256 is `950855294fa20d1e1628e658097d98e2947907eb219552006c0344102ec87aba`. On 2026-09-05, unauthenticated npm downloads matched the same archive, publication source fields identified the public HTTPS URL, and a fresh-cache installation exercised CLI/MCP concurrency, Core loading and threshold stopping, the demo, and bundle replay. The matching [MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.LBarimi%2Ffailtrace/versions/0.4.0) was active. The release source is main commit `0dd3f085594f963d753c8c2c93902b9829f1b70f`.

The [0.5.0 release](https://github.com/LBarimi/FailTrace/releases/tag/v0.5.0) publishes fix verification through Core, CLI and MCP. Its reviewed archive SHA-256 is `7a1104cb824bb1884ac6308ba9ad726d56307678b6a12ce3dc233b807f7f1757`. On 2026-09-05, an unauthenticated fresh-cache install of [failtrace 0.5.0](https://www.npmjs.com/package/failtrace/v/0.5.0) matched those bytes and exercised Core, CLI and MCP Verify, including an unrelated-error control. The installed package also completed the pinned Prettier and `p-memoize` affected/fixed workflows. The matching [MCP Registry record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.LBarimi%2Ffailtrace/versions/0.5.0) was active. The release source is main commit `6224d71562d4e7c101769915b7c6b6bd115a628a`. These maintainer checks establish published-package behavior, not independent use.

## Current priorities

1. **Observe useful results in real projects.** The installable package, guided demo, historical Prettier case and controlled `p-memoize` race case already exist. Collect voluntary evidence of developers investigating their own failures, whether the result changed their next step, and whether they returned to the tool. Use those observations to choose improvements; private logs and telemetry are not required.
2. **Validate agents using the released engine.** The 0.5.0 MCP adapter exposes all six operations, including Verify, and client guides already exist. Observe real Codex, Claude Code, or Cursor investigations: tool selection, bounded experiments, correct handling of failures and partial results, and evidence used after a patch. An SDK connection test establishes compatibility, not useful autonomous debugging.
3. **Shorten the path to current functionality.** Make the released Verify workflow and MCP connection as easy to try as the existing guided demo. Prefer tested, copyable installation and first-use paths over additional Core surface area, and address friction observed in the real-project and agent trials above.
4. **Preserve reliable distribution and evidence.** Keep fresh-install, replay, packaging, cross-platform CI, and performance checks current for each release. Maintain Core behavior independently of CLI/MCP and keep published-package capabilities distinct from unreleased source work. The [roadmap](ROADMAP.md) records implemented and planned work without making feature count the adoption goal.
5. **Improve discovery with demonstrated workflows.** Use accurate release notes, replayable examples, and voluntary reports. Additional cases should exercise an observed debugging need. Outreach, posts, and messages to other maintainers require explicit user authorization; no endorsement, testimonials, or usage counts should be inferred from maintainer tests or registry presence.

## Evidence to collect

| Question | Useful evidence | Interpretation limit |
| --- | --- | --- |
| Can a new user get value? | Fresh-directory install and demo; voluntary reports of time to first result | Maintainer smoke tests establish functionality, not adoption |
| Do developers use it on their own code? | Independent reports with a command, result, and optional public project link | Reports are self-selected |
| Do agents select it effectively? | Opt-in workflow transcripts showing tool choice and useful evidence | A hand-scripted SDK test is compatibility evidence only |
| Does usage repeat? | Follow-up reports, recurring integrations, external fixes and contributors | Downloads and stars are weak proxies |
| Is discovery improving? | Dated stars, forks, release asset downloads, referring integrations | Counters do not identify people or prove active use |

No runtime telemetry, account requirement, or automatic data collection is part of this plan. Keep claims tied to dated, inspectable evidence and adjust priorities when actual users show a different bottleneck.

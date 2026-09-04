# Product direction and roadmap

FailTrace helps developers and coding agents turn a difficult failure into repeatable experiments, a smaller reproducer, and inspectable evidence. The next missing Core operation is **fix verification**: after changing code, determine what the new observations establish about the original failure.

Success remains independent use and repeat use, as described in the [adoption goal](ADOPTION.md). The priorities below are not a release schedule or evidence of adoption.

## Capability priorities and current state

**Predicate → Compare → Bisect → Minimize → Verify → Bundle → MCP**

This expresses product emphasis, not a requirement to execute every operation in order or rebuild completed milestones. A small bug may need only reproduction and verification. A bundle can help another developer investigate before a fix exists. MCP already provides access to the engine and remains supported.

| Capability | Current state | Next emphasis |
| --- | --- | --- |
| Predicate | Implemented: nonzero/exact exit, stdout/stderr substring and regex | Identify the intended defect separately from execution problems |
| Compare | Implemented: saved runs, selected trial output, hashes, statistics and selected environment | Make comparable evidence easy to inspect; it currently gives no fix verdict |
| Bisect | Implemented: repeated first-parent candidate classification in an isolated worktree | Preserve inconclusive outcomes and source evidence |
| Minimize | Implemented: text, JSON/arrays, files and environment keys | Keep the same target failure and independently check the reduction |
| **Verify** | **Planned; no `verify` command, Core operation or MCP tool yet** | Validate a proposed fix against a suitable baseline with explicit evidence requirements |
| Bundle | Implemented: selected source/input, evidence and local replay engine | Preserve reproduction context and, after Verify exists, its report |
| MCP | Implemented: five tools that call Core | Expose stable Core operations; add verification only after its Core contract works |

The six original milestones are implemented in the published 0.3.1 package. The source also includes performance work after that release: opt-in concurrency, threshold stopping for bisect/minimize, efficient metadata, recovery, file-copy optimization and benchmarks. These source changes are not yet an npm release; see [performance scope and remaining limits](PERFORMANCE.md).

## Why Verify is next

An agent can already run commands again and compare two saved runs. That requires the caller to keep the original predicate and input, recognize incomplete or contaminated experiments, and avoid calling a different failure a successful fix. A dedicated operation earns its place by enforcing those requirements and linking the evidence, rather than just shortening two commands.

The [verification design and current workflow](VERIFY.md) define the initial scope. Before adding a public operation:

1. Validate the workflow using an affected/fixed control and negative controls: an unrelated error, an unchanged defect, and an interrupted experiment.
2. Implement baseline eligibility, explicit experiment settings, healthy completion checks, fixed-budget sampling and a linked report in Core. Results must separate observed target failures, absent observations and inconclusive evidence.
3. Exercise the Core contract on a recognizable real bug. The existing [Prettier case](../examples/cases/prettier-chain/README.md) supplies an affected/fixed example, not a generic verification API or proof of independent use.
4. Expose the same operation through CLI/JSON and the existing MCP adapter. Document limitations and verify the installed artifact before advertising a release.
5. Seek voluntary evidence that developers or agents used the workflow on their own fixes and returned to it. Adjust priorities if that reveals a more important obstacle.

## Positioning and market evidence

The useful combination is a framework-independent command, an explicit failure predicate, repeated experiments, regression isolation, input reduction and portable evidence. We should demonstrate that combination on real failures. Adding an LLM, dashboard or another tool name does not by itself establish differentiation.

Cypress Cloud MCP exposes recorded runs, flaky tests and failure details to agents. Cypress also offers `cypress tap`, which lets agents run and inspect local Cypress tests. Thus, describing all competing tools as passive data viewers would be inaccurate. These are distinct capabilities documented in [Cloud MCP](https://docs.cypress.io/cloud/integrations/cloud-mcp) and [Cypress AI tooling](https://docs.cypress.io/cloud/features/cypress-ai-features), reviewed on 2026-09-05.

Trunk documents framework-independent flaky-test detection, tracking, quarantine and remediation. Framework independence alone is therefore not a unique advantage either. Its documented scope is evidence of an existing developer problem, not evidence that those users will adopt FailTrace. See [Trunk's overview](https://docs.trunk.io/flaky-tests/overview).

Our product hypothesis is that reusable, local failure experiments and trustworthy after-fix evidence will be valuable across test frameworks and custom commands. That hypothesis needs usage evidence; competitor feature lists and a completed roadmap cannot validate it.

## Supporting work and boundaries

- Statistical uncertainty belongs with a defined sampling plan. Sequential trials are not automatically independent; zero observed failures do not prove elimination. Do not reuse bisect's classification stopping rule for an ordinary failure-rate confidence claim.
- Trial reset/isolation needs and resource limits should be driven by real workflows. The current runner has no general before/after-trial reset hooks, artifact budget or automatic retention. Project-owned wrapper scripts can perform setup/reset today.
- Further predicate modes, environment matrices, reducers and performance paths remain candidates, not committed releases. The syntax `--fail-when`, bisect/minimize `--run`, and `matrix` is not currently supported.
- Keep Core independent of the CLI, MCP, AI providers and cloud services. Maintain the existing adapter while prioritizing the quality of the experiments it exposes.

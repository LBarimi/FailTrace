# Bounded experiment output

These controls are implemented in the source checkout toward 1.0. They are not available in the published 0.6.0 package. Build the checkout before using them.

Repeated commands can emit unlimited output even when their input is small. An unattended debugging agent needs a finite evidence allowance and an explicit outcome when evidence is incomplete.

| Option | Default | Scope |
| --- | --- | --- |
| Core/MCP `maxOutputBytes`, CLI `--max-output-bytes` | 16777216 (16 MiB) | Combined stdout and stderr retained for one trial |
| Core/MCP `maxTotalOutputBytes`, CLI `--max-total-output-bytes` | 268435456 (256 MiB) | Combined output across one run, or all runs in one bisect/minimization |

Values are positive safe integers in bytes. Limits apply by default, including on concurrent runs. Larger limits are explicit choices; zero does not disable protection. A process that writes exactly the allowance and exits has complete output. The next byte exceeds it. Both streams and concurrent trials share their allowance; the distribution between streams depends on observed output arrival order.

```sh
node dist/cli/index.js run "node reproduce.js" --repeat 20 --max-output-bytes 1048576 --max-total-output-bytes 16777216 --json
```

FailTrace pipes output through bounded buffers with backpressure, retaining only bytes within the allowance. This can affect command timing and throughput, so use the same execution settings when comparing experiments. A truncated UTF-8 sequence stays as raw bytes in the saved file; decoders may show a replacement character.

## Incomplete evidence is inconclusive

When a cap is exceeded, the active process tree is stopped using the existing bounded best-effort cleanup, unstarted trials are skipped, and partial logs plus metadata are preserved. Run status is `resource_limited`; the affected trial has status `resource_limited`, termination reason `output_limit`, and `outputLimit: { scope, limitBytes }`. No target match or clean nonmatch is inferred from that trial, even if the retained prefix contains a matching message. `assessRun` returns `inconclusive`. Other trials that had already completed retain their own observations.

A failure writing command output has trial status and termination reason `output_error`, and run status `error`. The trial carries its error. It cannot become clean exit evidence. If the metadata filesystem is also unavailable, persistence can fail; no filesystem writer can promise durable evidence after disk loss.

CLI `run` returns exit 2 for these outcomes and prints the artifact location. MCP returns structured evidence with the status and limit details. Saved inspection includes these trials in the `unhealthy` filter. A failure rate still counts execution failures; it is not a target-match rate or a success verdict.

Bisect shares the total allowance across endpoints and candidates and stops inconclusively on incomplete execution. Minimize shares it across baseline, reductions and final checks. Once output is incomplete, it stops evaluating candidates and does not claim independent final verification. An evaluation-count limit and an output limit have different effects: the former reserves a final recheck; the latter cannot supply clean evidence for one.

## Verify and replay

Verify inherits both output caps from its baseline. Overrides require an explicit `outputLimits` change allowance and reason, just like changes to timeout or concurrency. Baselines made before output caps existed have unknown caps: capture a new baseline or explicitly acknowledge that change. Allowing different caps never makes a truncated candidate eligible for a healthy verdict.

```sh
node dist/cli/index.js verify <baseline> --command "node reproduce.js" --cwd . --max-output-bytes 33554432 --allow-change "outputLimits:allow the reviewed additional diagnostics" --json
```

Bundles record the source run's caps and replay with them. Older source runs use the new finite defaults. Replay returns 2 when evidence is inconclusive, including output exhaustion. No target command executes while creating a bundle.

## Scope and remaining storage work

These are output byte budgets, not a cap on the entire artifact directory or a process sandbox. They do not account for metadata, copied minimization inputs, Git worktrees, dependency installations, files written directly by the target, or previous investigations. Candidate storage and metadata reconstruction need separate controls before the planned 1.0 release. No automatic deletion or retention schedule is applied.

Commands still run with local permissions. Timeout and descendant cleanup remain best effort, and a target can use files or processes outside these output pipes. Review sensitive output before sharing evidence.

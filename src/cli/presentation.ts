import { relative } from 'node:path';
import type { ComparisonResult, RunSummary, TrialResult, VerifyResult } from '../core/index.js';
import type { DemoProgress, DemoResult } from '../demo/index.js';

export const HELP = `FailTrace - Reproduce. Isolate. Minimize.

Reproduce failures, compare evidence, isolate regressions, and reduce inputs.

Usage:
  failtrace demo [--cwd DIRECTORY] [--json]
  failtrace run "<command>" [--repeat N] [--timeout DURATION] [--concurrency N]
  failtrace compare <run-a> [run-b] [--trial-a N] [--trial-b N]
  failtrace bisect --good REF --bad REF --command "<command>"
  failtrace minimize --input PATH --command "<command>" [--format text]
  failtrace verify <baseline> --command "<command>" --cwd DIRECTORY
  failtrace bundle <run> [--file PATH ...] [--input PATH]
  failtrace mcp [--cwd DIRECTORY]
  failtrace --help
  failtrace --version

Experiment options (run, bisect, minimize):
  --repeat N          Trial count, at most 100000 (run: 10, bisect: 5, minimize: 1)
                     Bisect/minimize stop once the threshold is decided.
  --timeout DURATION  Per-trial limit (default: 30s); ms, s, or m
                     Bare numbers are milliseconds; fractional units are
                     accepted when they resolve to whole milliseconds.
  --exit-code N      Reproduce this exit code, including 0
  --stdout-contains TEXT | --stderr-contains TEXT
  --stdout-regex REGEX   | --stderr-regex REGEX [--regex-flags imsu]
                     Choose one predicate; default is a non-zero exit.
  --min-failures N    Matches required per candidate (bisect/minimize: 1)
  --max-output-bytes N       Combined stdout/stderr cap per trial (16777216)
  --max-total-output-bytes N Combined output cap for all candidates (268435456)
                            A limit preserves partial logs; result is inconclusive.

Command-specific options:
  run       --capture-env KEY1,KEY2 (selected values only)
            --concurrency N (run default: 1; at most 64)
            --capture-context (record source identity for later verification)
            --context-input FILE, --context-setup FILE, --context-source FILE
            (repeatable regular files; each implies --capture-context)
  compare   --max-lines N (200), --max-bytes N (65536)
  minimize  --format text|json|files|env, --max-evaluations N (200; range 2..10000)
            --max-input-bytes N (16777216), --max-candidate-bytes N (268435456)
  verify    --repeat N, --timeout DURATION, --concurrency N (inherit baseline)
            --allow-change FIELD:REASON (repeatable; declare interventions)
            Fields: command, source, inputs, setup, environment, timeout,
            concurrency, outputLimits. --healthy-exit-code N (repeatable; default: 0)
            Output caps inherit baseline; changing them needs an allowance.
            Predicate and context declarations are inherited from baseline.
  bundle    --file PATH (repeatable), --input PATH, --command COMMAND,
            --output NEW_DIRECTORY, --env-file JSON_FILE
            --include-env KEY (repeatable selected captured values)
            --include-evidence (unchanged original metadata/logs; default excluded)
            --max-bundle-bytes N (536870912)

Common options:
  --cwd DIRECTORY    Resolve command/input/artifact paths from this directory
  --json             Print only JSON results (all commands except mcp)
  --help, -h         Show this help
  --version, -v      Show the installed version

Examples:
  failtrace demo
  failtrace run "npm test -- checkout" --repeat 20
  failtrace run "node examples/flaky-demo.js" --repeat 10
  failtrace run "npm test" --repeat 5 --stderr-contains "checkout failed"
  failtrace minimize --input examples/advanced-input.json --format json --command "node examples/advanced-demo.js" --stderr-contains "BUG reproduced"

The command runs in the current directory using the platform shell.
Commands are limited to 64 KiB UTF-8; use a project-owned script for longer commands.
Concurrent run trials can change failure behavior through shared resources.
Progress uses completion order with trial indices; JSON trials use index order.
Artifacts: .failtrace/ (runs, bisects, minimizations, verifications, reproduction, demos).
Demo works from any directory and exits 0 when its expected failures are shown.
Minimize exposes FAILTRACE_INPUT or FAILTRACE_INPUT_DIR to the command.
Bundles contain the Node engine; install target dependencies separately.
Review manifest.json before sharing; original logs and captured values are opt-in.
Verify reports finite observations, never proof that a bug is eliminated.
Exit codes: 0 success/verify target not observed, 1 run failure/verify target observed,
            2 error/inconclusive/limit,
            130 interrupted by Ctrl+C, 143 interrupted by SIGTERM.
`;

export function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(2)}s`;
}

export function formatHeader(command: string, repeat: number, timeoutMs: number, concurrency = 1): string {
  return [
    'FailTrace',
    '',
    `Command   ${command}`,
    `Trials    ${repeat}`,
    `Timeout   ${formatDuration(timeoutMs)}`,
    `Concurrency ${concurrency}`,
    '',
    concurrency > 1 ? 'Running (completion order; labels are trial indices)' : 'Running (trial index)',
    '',
  ].join('\n');
}

export function formatTrial(trial: TrialResult, requestedTrials?: number): string {
  const labels = {
    passed: 'PASS',
    failed: 'FAIL',
    timed_out: 'TIMEOUT',
    spawn_error: 'SPAWN ERROR',
    interrupted: 'INTERRUPTED',
    resource_limited: 'OUTPUT LIMIT',
    output_error: 'OUTPUT ERROR',
  } as const;
  const index = String(trial.index).padStart(Math.max(2, String(requestedTrials ?? trial.index).length), '0');
  const detail = trial.status === 'failed'
    ? trial.signal ? `  signal ${trial.signal}` : `  exit ${trial.exitCode}`
    : '';
  return `  Trial ${index}  ${labels[trial.status].padEnd(11)} ${formatDuration(trial.durationMs)}${detail}`;
}

export function formatSummary(summary: RunSummary): string {
  const { statistics } = summary;
  const interrupted = summary.status === 'interrupted';
  const artifactPath = relative(process.cwd(), summary.artifactDirectory) || summary.artifactDirectory;
  const matched = summary.trials.filter((trial) => trial.failureMatched ?? trial.status === 'failed').length;
  return [
    '',
    interrupted ? 'Results (partial - interrupted)' : 'Results',
    '',
    `  Trials         ${statistics.total} / ${summary.requestedTrials}`,
    `  Passed         ${statistics.passed}`,
    `  Failed         ${statistics.failed}`,
    `  Matched        ${matched}`,
    `  Failure rate   ${(statistics.failureRate * 100).toFixed(1)}%`,
    '',
    'Duration',
    '',
    `  Min            ${formatDuration(statistics.durationMs.min)}`,
    `  Avg            ${formatDuration(statistics.durationMs.average)}`,
    `  Max            ${formatDuration(statistics.durationMs.max)}`,
    '',
    interrupted
      ? 'Run interrupted. Saved trials include interrupted trials that were active.'
      : summary.status === 'resource_limited' ? summary.metadataLimit
        ? 'Run inconclusive: metadata allowance reached. Completed evidence is preserved.'
        : 'Run inconclusive: output limit reached. Partial logs are preserved.'
      : summary.status === 'error' ? 'Run inconclusive: evidence could not be fully persisted.'
      : matched > 0 ? 'Failure reproduced.' : statistics.failed > 0
        ? 'Target failure not reproduced; inspect execution failure evidence.' : 'No failure reproduced in this run.',
    '',
    'Artifacts:',
    artifactPath,
  ].join('\n');
}

export function formatComparison(result: ComparisonResult): string {
  const lines = [
    'FailTrace - evidence comparison', '',
    `A  ${result.runA}  trial ${result.trialA}`,
    `B  ${result.runB}  trial ${result.trialB}`, '',
    `Failure rate  ${(result.statisticsA.failureRate * 100).toFixed(1)}% -> ${(result.statisticsB.failureRate * 100).toFixed(1)}%`,
    `Command changed    ${result.commandChanged ? 'yes' : 'no'}`,
    `Concurrency changed ${result.concurrencyChanged ? 'yes' : 'no'}`,
    `Predicate changed  ${result.predicateChanged ? 'yes' : 'no'}`,
  ];
  for (const stream of ['stdout', 'stderr'] as const) {
    const output = result[stream];
    lines.push('', `${stream}: ${output.equal ? 'identical' : 'different'} (${output.bytesA} / ${output.bytesB} bytes)`, ...output.diff);
    if (output.truncated) lines.push('[diff truncated; complete stream hashes are available with --json]');
  }
  if (result.environmentChanges.length > 0) {
    lines.push('', 'Environment changes');
    for (const change of result.environmentChanges) lines.push(`  ${change.key}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
  }
  return lines.join('\n');
}

export function formatVerification(result: VerifyResult): string {
  const lines = ['', `Result  ${result.status}`, ''];
  for (const [label, evidence] of [['Baseline', result.baseline], ['Candidate', result.candidate]] as const) {
    lines.push(`${label}  ${evidence ? `${evidence.matchedTrials} target matches / ${evidence.completedTrials} completed / ${evidence.requestedTrials} requested; ${evidence.unhealthyTrials} unhealthy` : 'not run or unavailable'}`);
    if (evidence && evidence.unhealthyTrials > 0) {
      lines.push(`  Infrastructure ${evidence.infrastructureTrials}; unrelated failures ${evidence.unrelatedFailureTrials}; invalid evidence ${evidence.invalidEvidenceTrials}`);
    }
  }
  for (const change of result.changes) {
    lines.push(`Changed ${change.field}  ${change.allowed ? 'declared' : 'not allowed'}${change.reason ? `: ${change.reason}` : ''}`);
  }
  for (const reason of result.reasons) lines.push(`Reason  ${reason}`);
  lines.push('', result.status === 'target_not_observed'
    ? 'The target failure was not observed in this healthy, comparable sample. This does not prove elimination.'
    : result.status === 'target_observed' ? 'The target failure was observed in the candidate sample.'
      : 'The evidence does not establish an absent target failure. Inspect the report before drawing a conclusion.');
  lines.push('', 'Report:', result.metadataPath);
  return lines.join('\n');
}

export function formatDemoProgress(progress: DemoProgress): string | undefined {
  if (progress.trial) return formatTrial(progress.trial, 10);
  if (progress.verification) {
    const labels = { baseline_control: 'Baseline control', unrelated_candidate: 'Unrelated crash', fixed_candidate: 'Intended fix' };
    return `  ${labels[progress.verification.candidate]}: ${progress.verification.observation.status.replaceAll('_', ' ')}.`;
  }
  if (progress.evaluation) {
    return progress.evaluation.accepted ? `  Kept a smaller input: ${progress.evaluation.units} JSON nodes; failure still reproduced.` : undefined;
  }
  return {
    repetition: '\n1/4  Measure a flaky command\n',
    minimization: '\n2/4  Remove input while keeping the same failure\n',
    verification: '\n3/4  Check the minimized failure after a proposed fix\n',
    bundle: '\n4/4  Save a portable reproduction',
  }[progress.stage];
}

export function formatDemoResult(result: DemoResult): string {
  const lines = ['', result.status === 'completed' ? 'Demo complete.' : `Demo ${result.status}.`];
  if (result.repetition) {
    const { passed, failed, total, failureRate } = result.repetition.statistics;
    lines.push(`  ${passed} passed, ${failed} failed out of ${total} trials (${(failureRate * 100).toFixed(1)}%).`);
  }
  if (result.reduction) lines.push(`  Input: ${JSON.stringify(result.reduction.originalInput)} -> ${JSON.stringify(result.reduction.minimizedInput)}`, `  Final failure verified: ${result.reduction.finalVerified ? 'yes' : 'no'}.`);
  if (result.verification) {
    const { baselineControl, unrelatedCandidate, fixedCandidate } = result.verification;
    lines.push('', '  Fix verification:');
    if (baselineControl) lines.push(`  Baseline control   target observed — ${baselineControl.matchedTrials}/${baselineControl.completedTrials} target matches.`);
    if (unrelatedCandidate) lines.push(`  Unrelated crash    inconclusive — ${unrelatedCandidate.matchedTrials} matches, ${unrelatedCandidate.unrelatedFailureTrials} unrelated failures.`);
    if (fixedCandidate) lines.push(`  Intended fix       target not observed — ${fixedCandidate.matchedTrials}/${fixedCandidate.completedTrials} matches, ${fixedCandidate.healthyTrials} healthy.`);
    if (fixedCandidate?.status === 'target_not_observed') {
      lines.push('  No target match was observed in this finite sample; this does not prove elimination.');
    }
  }
  if (result.error) lines.push('', result.error);
  if (result.replayCommand) lines.push('', 'Replay the reduced failure:', result.replayCommand, 'Replay exits 1 when the expected failure is reproduced.');
  lines.push('', 'Evidence:', result.artifactDirectory);
  if (result.status === 'completed') lines.push('', 'Try your own command:', 'failtrace run "npm test" --repeat 20');
  return lines.join('\n');
}

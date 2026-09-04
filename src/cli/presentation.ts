import { relative } from 'node:path';
import type { ComparisonResult, RunSummary, TrialResult } from '../core/index.js';

export const HELP = `FailTrace - Reproduce. Isolate. Minimize.

Reproduce failures, compare evidence, isolate regressions, and reduce inputs.

Usage:
  failtrace run "<command>" [--repeat N] [--timeout DURATION]
  failtrace compare <run-a> [run-b] [--trial-a N] [--trial-b N]
  failtrace bisect --good REF --bad REF --command "<command>"
  failtrace minimize --input PATH --command "<command>" [--format text]
  failtrace bundle <run> [--file PATH ...] [--input PATH]
  failtrace mcp [--cwd DIRECTORY]
  failtrace --help
  failtrace --version

Experiment options (run, bisect, minimize):
  --repeat N          Sequential trials (run: 10, bisect: 5, minimize: 1)
  --timeout DURATION  Per-trial limit (default: 30s); ms, s, or m
                     Bare numbers are milliseconds; fractional units are
                     accepted when they resolve to whole milliseconds.
  --exit-code N      Reproduce this exit code, including 0
  --stdout-contains TEXT | --stderr-contains TEXT
  --stdout-regex REGEX   | --stderr-regex REGEX [--regex-flags imsu]
                     Choose one predicate; default is a non-zero exit.
  --min-failures N    Matches required per candidate (bisect/minimize: 1)

Command-specific options:
  run       --capture-env KEY1,KEY2 (selected values only)
  compare   --max-lines N (200), --max-bytes N (65536)
  minimize  --format text|json|files|env, --max-evaluations N (200)
  bundle    --file PATH (repeatable), --input PATH, --command COMMAND,
            --output NEW_DIRECTORY, --env-file JSON_FILE

Common options:
  --cwd DIRECTORY    Resolve command/input/artifact paths from this directory
  --json             Print only JSON results (all commands except mcp)
  --help, -h         Show this help
  --version, -v      Show the installed version

Examples:
  failtrace run "npm test -- checkout" --repeat 20
  failtrace run "node examples/flaky-demo.js" --repeat 10
  failtrace run "npm test" --repeat 5 --stderr-contains "checkout failed"
  failtrace minimize --input examples/advanced-input.json --format json --command "node examples/advanced-demo.js" --stderr-contains "BUG reproduced"

The command runs in the current directory using the platform shell.
Artifacts: .failtrace/ (runs, bisects, minimizations, reproduction).
Minimize exposes FAILTRACE_INPUT or FAILTRACE_INPUT_DIR to the command.
Bundles contain the Node engine; install target dependencies separately.
Exit codes: 0 success, 1 run target failure, 2 error/inconclusive/limit,
            130 interrupted by Ctrl+C, 143 interrupted by SIGTERM.
`;

export function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(2)}s`;
}

export function formatHeader(command: string, repeat: number, timeoutMs: number): string {
  return [
    'FailTrace',
    '',
    `Command   ${command}`,
    `Trials    ${repeat}`,
    `Timeout   ${formatDuration(timeoutMs)}`,
    '',
    'Running',
    '',
  ].join('\n');
}

export function formatTrial(trial: TrialResult, requestedTrials: number): string {
  const labels = {
    passed: 'PASS',
    failed: 'FAIL',
    timed_out: 'TIMEOUT',
    spawn_error: 'SPAWN ERROR',
    interrupted: 'INTERRUPTED',
  } as const;
  const index = String(trial.index).padStart(Math.max(2, String(requestedTrials).length), '0');
  const detail = trial.status === 'failed'
    ? trial.signal ? `  signal ${trial.signal}` : `  exit ${trial.exitCode}`
    : '';
  return `  ${index}  ${labels[trial.status].padEnd(11)} ${formatDuration(trial.durationMs)}${detail}`;
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
      ? 'Run interrupted. Saved trials include the interrupted trial when one was active.'
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

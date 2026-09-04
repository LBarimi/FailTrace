import { relative } from 'node:path';
import type { RunSummary, TrialResult } from '../core/index.js';

export const HELP = `FailTrace - Reproduce. Isolate. Minimize.

Repeat a command and preserve evidence of every trial.

Usage:
  failtrace run "<command>" [--repeat N] [--timeout DURATION]
  failtrace --help
  failtrace --version

Options:
  --repeat N          Number of sequential trials (default: 10)
  --timeout DURATION  Per-trial limit (default: 30s); ms, s, or m
                     Bare numbers are milliseconds; fractional units are
                     accepted when they resolve to whole milliseconds.
  --help, -h         Show this help
  --version, -v      Show the installed version

Examples:
  failtrace run "npm test -- checkout" --repeat 20
  failtrace run "node examples/flaky-demo.js" --repeat 10
  failtrace run "npm test" --repeat 5 --timeout 2m

The command runs in the current directory using the platform shell.
Artifacts: .failtrace/runs/<run-id>/
Exit codes: 0 all pass, 1 target failure, 2 usage/internal error,
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
  return [
    '',
    interrupted ? 'Results (partial - interrupted)' : 'Results',
    '',
    `  Trials         ${statistics.total} / ${summary.requestedTrials}`,
    `  Passed         ${statistics.passed}`,
    `  Failed         ${statistics.failed}`,
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
      : statistics.failed > 0 ? 'Failure reproduced.' : 'No failure reproduced in this run.',
    '',
    'Artifacts:',
    artifactPath,
  ].join('\n');
}

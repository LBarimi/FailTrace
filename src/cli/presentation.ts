import { relative } from 'node:path';
import type { ComparisonResult, RunSummary, TrialResult, VerifyResult } from '../core/index.js';
import type { DemoProgress, DemoResult } from '../demo/index.js';

export { HELP } from './help.js';

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
  const checkpoint = trial.executionMatched === false ? '  required checkpoint missing' : '';
  return `  Trial ${index}  ${labels[trial.status].padEnd(11)} ${formatDuration(trial.durationMs)}${detail}${checkpoint}`;
}

export function formatSummary(summary: RunSummary): string {
  const { statistics } = summary;
  const interrupted = summary.status === 'interrupted';
  const artifactPath = relative(process.cwd(), summary.artifactDirectory) || summary.artifactDirectory;
  const matched = summary.trials.filter((trial) => trial.failureMatched ?? trial.status === 'failed').length;
  const missingExecution = summary.executionRequirement === undefined ? 0 : summary.trials.filter(trial => trial.executionMatched !== true).length;
  return [
    '',
    interrupted ? 'Results (partial - interrupted)' : 'Results',
    '',
    `  Trials         ${statistics.total} / ${summary.requestedTrials}`,
    `  Passed         ${statistics.passed}`,
    `  Failed         ${statistics.failed}`,
    `  Matched        ${matched}`,
    ...(summary.executionRequirement === undefined ? [] : [`  Checkpoint     ${statistics.total - missingExecution} / ${statistics.total} observed`]),
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
      : missingExecution > 0 ? 'Run inconclusive: required execution checkpoint missing. Check whether the intended check ran.'
      : matched > 0 ? 'Failure reproduced.' : statistics.failed > 0
        ? 'Target failure not reproduced; inspect execution failure evidence.' : 'No failure reproduced in this run.',
    '',
    'Artifacts:',
    artifactPath,
  ].join('\n');
}

export function formatComparison(result: ComparisonResult): string {
  const selected = (label: 'a' | 'b'): string => {
    const trial = result.selectedTrials?.[label];
    if (!trial) return '';
    return `  ${trial.status}; exit ${trial.exitCode ?? '-'}; target ${trial.failureMatched === undefined ? 'unknown' : trial.failureMatched ? 'matched' : 'not matched'}`;
  };
  const lines = [
    'FailTrace - evidence comparison', '',
    `A  ${result.runA}  trial ${result.trialA}${selected('a')}`,
    `B  ${result.runB}  trial ${result.trialB}${selected('b')}`, '',
    ...(result.warnings ?? []).map((warning) => `Note  ${warning}`),
    `Failed outcome rate  ${(result.statisticsA.failureRate * 100).toFixed(1)}% -> ${(result.statisticsB.failureRate * 100).toFixed(1)}% (includes execution errors)`,
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

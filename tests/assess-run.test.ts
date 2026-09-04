import { describe, expect, it } from 'vitest';
import { assessRun } from '../src/core/predicates.js';
import type { RunSummary, TrialResult } from '../src/core/types.js';

function evidence(matches: boolean[], requestedTrials = 5): RunSummary {
  const trials: TrialResult[] = matches.map((failureMatched, offset) => ({
    index: offset + 1, command: 'test', startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.001Z', durationMs: 1, exitCode: failureMatched ? 1 : 0,
    signal: null, status: failureMatched ? 'failed' : 'passed', timedOut: false,
    spawningFailed: false, terminationReason: 'exit', failureMatched,
    stdoutPath: `trials/${offset + 1}/stdout.txt`, stderrPath: `trials/${offset + 1}/stderr.txt`,
  }));
  const failed = matches.filter(Boolean).length;
  return {
    schemaVersion: 1, failtraceVersion: 'test', id: 'test', command: 'test', cwd: '/test',
    requestedTrials, timeoutMs: 1000, startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.001Z', status: 'completed', artifactDirectory: '/test/run', trials,
    statistics: { total: trials.length, passed: trials.length - failed, failed,
      failureRate: failed / Math.max(1, trials.length), durationMs: { min: 1, average: 1, max: 1 } },
  };
}

describe('assessRun evidence decisions', () => {
  it('accepts full legacy evidence without an early-decision marker', () => {
    const run = evidence([false, true], 2);
    for (const trial of run.trials) delete trial.failureMatched;
    expect(assessRun(run, 1)).toBe('reproduced');
    expect(assessRun(run, 2)).toBe('not_reproduced');
  });

  it('accepts reproduction immediately at the threshold with a matching marker', () => {
    const run = evidence([true]);
    run.decision = { minFailures: 1, outcome: 'reproduced', completedTrials: 1 };
    expect(assessRun(run, 1)).toBe('reproduced');
    expect(run.requestedTrials).toBe(5);
  });

  it('can reassess a complete run at another threshold without relying on its original decision', () => {
    const run = evidence([false, true], 2);
    run.decision = { minFailures: 1, outcome: 'reproduced', completedTrials: 2 };
    expect(assessRun(run, 2)).toBe('not_reproduced');
  });

  it('accepts nonreproduction only once remaining trials cannot reach the threshold', () => {
    const run = evidence([false, false]);
    run.decision = { minFailures: 3, outcome: 'not_reproduced', completedTrials: 2 };
    expect(assessRun(run, 3)).toBe('inconclusive');
    run.trials.push({ ...run.trials[0]!, index: 3 });
    run.decision.completedTrials = 3;
    expect(assessRun(run, 3)).toBe('not_reproduced');
  });

  it('does not infer a completed classification from an unmarked partial run', () => {
    expect(assessRun(evidence([true]), 1)).toBe('inconclusive');
    expect(assessRun(evidence([false, false, false]), 3)).toBe('inconclusive');
  });

  it('treats a malformed decision marker as inconclusive', () => {
    const run = evidence([true]);
    Object.assign(run, { decision: null });
    expect(assessRun(run)).toBe('inconclusive');
  });

  it.each([
    { minFailures: 2, outcome: 'reproduced', completedTrials: 1 },
    { minFailures: 1, outcome: 'not_reproduced', completedTrials: 1 },
    { minFailures: 1, outcome: 'reproduced', completedTrials: 2 },
  ] as const)('rejects a marker that disagrees with the request or evidence: %j', (decision) => {
    const run = evidence([true]);
    run.decision = decision;
    expect(assessRun(run, 1)).toBe('inconclusive');
  });

  it.each<Partial<TrialResult>>([
    { terminationReason: 'timeout', timedOut: true }, { spawningFailed: true },
    { terminationReason: 'interrupted', status: 'interrupted' }, { error: 'cleanup failed' },
    { exitCode: null }, { signal: 'SIGTERM' }, { index: 2 }, { failureMatched: false },
  ])('rejects infrastructure or inconsistent evidence despite a positive marker: %j', (change) => {
    const run = evidence([true]);
    run.decision = { minFailures: 1, outcome: 'reproduced', completedTrials: 1 };
    Object.assign(run.trials[0]!, change);
    expect(assessRun(run, 1)).toBe('inconclusive');
  });

  it.each(['running', 'interrupted', 'error'] as const)('rejects %s runs despite a positive marker', (status) => {
    const run = evidence([true]);
    run.decision = { minFailures: 1, outcome: 'reproduced', completedTrials: 1 };
    run.status = status;
    expect(assessRun(run)).toBe('inconclusive');
  });

  it('rejects a run-level error and duplicate trial evidence', () => {
    const run = evidence([true, true]);
    run.decision = { minFailures: 2, outcome: 'reproduced', completedTrials: 2 };
    run.error = 'metadata failure';
    expect(assessRun(run, 2)).toBe('inconclusive');
    delete run.error;
    run.trials[1]!.index = 1;
    expect(assessRun(run, 2)).toBe('inconclusive');
  });

  it.each([0, -1, 1.5, Number.NaN, 6])('validates the requested threshold %s', (minFailures) => {
    expect(() => assessRun(evidence([true]), minFailures)).toThrow(/minFailures/);
  });
});

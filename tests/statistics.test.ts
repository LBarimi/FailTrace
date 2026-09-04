import { describe, expect, it } from 'vitest';
import { aggregateStatistics } from '../src/core/statistics.js';
import type { TrialResult, TrialStatus } from '../src/core/types.js';

function trial(status: TrialStatus, durationMs: number, index = 1): TrialResult {
  return {
    index,
    command: 'fixture',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs,
    exitCode: status === 'passed' ? 0 : 7,
    signal: null,
    status,
    timedOut: status === 'timed_out',
    spawningFailed: status === 'spawn_error',
    terminationReason: 'exit',
    stdoutPath: 'trials/001/stdout.txt',
    stderrPath: 'trials/001/stderr.txt',
  };
}

describe('aggregateStatistics', () => {
  it('calculates exact counts, failure fraction, and duration statistics', () => {
    const trials = [trial('passed', 10), trial('failed', 40), trial('passed', 25)];
    expect(aggregateStatistics(trials)).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      failureRate: 1 / 3,
      durationMs: { min: 10, average: 25, max: 40 },
    });
    expect(trials.map(({ durationMs }) => durationMs)).toEqual([10, 40, 25]);
  });

  it('counts timeouts, spawn errors, and interruptions as failures', () => {
    expect(aggregateStatistics([
      trial('timed_out', 0), trial('spawn_error', 0), trial('interrupted', 0),
    ])).toEqual({
      total: 3,
      passed: 0,
      failed: 3,
      failureRate: 1,
      durationMs: { min: 0, average: 0, max: 0 },
    });
  });

  it('represents an empty partial run without NaN or infinity', () => {
    expect(aggregateStatistics([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      failureRate: 0,
      durationMs: { min: 0, average: 0, max: 0 },
    });
  });
});

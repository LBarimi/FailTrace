import type { RunStatistics, TrialResult } from './types.js';

export function aggregateStatistics(trials: readonly TrialResult[]): RunStatistics {
  let passed = 0;
  let minimum = Infinity;
  let maximum = 0;
  let totalDuration = 0;
  for (const trial of trials) {
    if (trial.status === 'passed') passed++;
    minimum = Math.min(minimum, trial.durationMs);
    maximum = Math.max(maximum, trial.durationMs);
    totalDuration += trial.durationMs;
  }
  const total = trials.length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    failureRate: total === 0 ? 0 : failed / total,
    durationMs: {
      min: total === 0 ? 0 : minimum,
      average: total === 0 ? 0 : totalDuration / total,
      max: maximum,
    },
  };
}

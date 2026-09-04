import type { RunStatistics, TrialResult } from './types.js';

/** Constant work per observation; snapshots never share mutable state. */
export function createStatisticsAccumulator(): { add(trial: TrialResult): void; snapshot(): RunStatistics } {
  let total = 0;
  let passed = 0;
  let minimum = Infinity;
  let maximum = 0;
  let totalDuration = 0;
  const add = (trial: TrialResult): void => {
    total++;
    if (trial.status === 'passed') passed++;
    minimum = Math.min(minimum, trial.durationMs);
    maximum = Math.max(maximum, trial.durationMs);
    totalDuration += trial.durationMs;
  };
  const snapshot = (): RunStatistics => {
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
  };
  return { add, snapshot };
}

export function aggregateStatistics(trials: readonly TrialResult[]): RunStatistics {
  const accumulator = createStatisticsAccumulator();
  for (const trial of trials) accumulator.add(trial);
  return accumulator.snapshot();
}

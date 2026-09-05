import { matchesFailure } from './predicates.js';
import type { ExecutionRequirement, TrialResult } from './types.js';

export function validateExecutionRequirement(value: ExecutionRequirement): void {
  if (!value || typeof value !== 'object' || !['stdout', 'stderr'].includes(value.stream)
    || typeof value.contains !== 'string' || !value.contains.length || value.contains.length > 1_048_576) {
    throw new Error('Execution requirement needs stdout or stderr and 1 to 1048576 characters of checkpoint text.');
  }
}

/** Reuses bounded UTF-8 substring matching; infrastructure outcomes never establish completion. */
export async function matchesExecution(
  trial: TrialResult, directory: string, requirement: ExecutionRequirement,
): Promise<boolean> {
  return matchesFailure(trial, directory, {
    kind: requirement.stream === 'stdout' ? 'stdout_contains' : 'stderr_contains', value: requirement.contains,
  });
}

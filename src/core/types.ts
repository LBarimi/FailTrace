import type { ContextCaptureOptions, RunContext } from './verify-context.js';
import type { OutputBudget, OutputLimit, OutputLimits } from './output-budget.js';
import type { MetadataLimit } from './metadata-budget.js';

export type TrialStatus = 'passed' | 'failed' | 'timed_out' | 'spawn_error' | 'interrupted' | 'resource_limited' | 'output_error';
export type TerminationReason = 'exit' | 'signal' | 'timeout' | 'spawn_error' | 'interrupted' | 'output_limit' | 'output_error';

/** A single, explicit target failure rule. Text predicates match decoded UTF-8 output. */
export type FailurePredicate =
  | { kind: 'nonzero_exit' }
  | { kind: 'exit_code'; value: number }
  | { kind: 'stdout_contains' | 'stderr_contains'; value: string }
  | { kind: 'stdout_regex' | 'stderr_regex'; pattern: string; flags?: string };

/** An opt-in checkpoint emitted by the target after the intended check ran. */
export interface ExecutionRequirement { stream: 'stdout' | 'stderr'; contains: string }

export interface EnvironmentSnapshot {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  shell: string;
  /** Only explicitly selected environment keys are recorded. */
  variables: Record<string, string | null>;
}

/** Output paths are relative to the containing run's artifactDirectory. */
export interface TrialResult {
  index: number;
  command: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: TrialStatus;
  timedOut: boolean;
  spawningFailed: boolean;
  terminationReason: TerminationReason;
  error?: string;
  stdoutPath: string;
  stderrPath: string;
  /** Whether the configured predicate matched; absent in older artifacts. */
  failureMatched?: boolean;
  /** Checkpoint observed after a clean exit; absent means not requested or unknown. */
  executionMatched?: boolean;
  /** Output was incomplete. A truncated stream never establishes a target nonmatch. */
  outputLimit?: OutputLimit;
}

export interface RunStatistics {
  total: number;
  passed: number;
  failed: number;
  /** Fraction in [0, 1]; zero when no trials completed. */
  failureRate: number;
  durationMs: { min: number; average: number; max: number };
}

export interface RunSummary extends OutputLimits {
  schemaVersion: 1;
  failtraceVersion: string;
  id: string;
  command: string;
  cwd: string;
  requestedTrials: number;
  /** Maximum simultaneous trials; absent in older artifacts means one. */
  concurrency?: number;
  timeoutMs: number;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'interrupted' | 'error' | 'resource_limited';
  artifactDirectory: string;
  trials: TrialResult[];
  statistics: RunStatistics;
  /** A clean threshold decision; requestedTrials remains the original budget. */
  decision?: { minFailures: number; outcome: 'reproduced' | 'not_reproduced'; completedTrials: number };
  error?: string;
  predicate?: FailurePredicate;
  executionRequirement?: ExecutionRequirement;
  /** No further trial could be safely recorded within the investigation allowance. */
  metadataLimit?: MetadataLimit;
  environment?: EnvironmentSnapshot;
  /** Opt-in declared file and local source identities, captured before and after execution. */
  context?: RunContext;
  /** Immutable source provenance for runs executed in temporary Git worktrees. */
  source?: { kind: 'git'; repository: string; commit: string; subdirectory: string };
}

export interface RunOptions extends OutputLimits {
  command: string;
  repeat?: number;
  /** Opt-in parallelism changes resource contention and potentially failure behavior. Defaults to one. */
  concurrency?: number;
  timeoutMs?: number;
  cwd?: string;
  /** Parent directory for runs; defaults to cwd/.failtrace. */
  artifactsDir?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Called after durable trial metadata, in completion order. Returned trials are index ordered. */
  onTrialComplete?: ((trial: TrialResult) => void) | ((trial: TrialResult) => Promise<void>);
  /** Classification only, with concurrency one; ordinary runs always exhaust repeat. */
  stopWhenDecided?: { minFailures: number };
  predicate?: FailurePredicate;
  executionRequirement?: ExecutionRequirement;
  captureEnv?: string[];
  captureContext?: ContextCaptureOptions;
}

/** Internal execution contract; paths returned in TrialResult are run-relative. */
export interface TrialOptions {
  index: number;
  command: string;
  cwd: string;
  timeoutMs: number;
  runDirectory: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  outputBudget?: OutputBudget;
}

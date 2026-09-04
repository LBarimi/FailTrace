export type TrialStatus = 'passed' | 'failed' | 'timed_out' | 'spawn_error' | 'interrupted';
export type TerminationReason = 'exit' | 'signal' | 'timeout' | 'spawn_error' | 'interrupted';

/** A single, explicit target failure rule. Text predicates match decoded UTF-8 output. */
export type FailurePredicate =
  | { kind: 'nonzero_exit' }
  | { kind: 'exit_code'; value: number }
  | { kind: 'stdout_contains' | 'stderr_contains'; value: string }
  | { kind: 'stdout_regex' | 'stderr_regex'; pattern: string; flags?: string };

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
}

export interface RunStatistics {
  total: number;
  passed: number;
  failed: number;
  /** Fraction in [0, 1]; zero when no trials completed. */
  failureRate: number;
  durationMs: { min: number; average: number; max: number };
}

export interface RunSummary {
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
  status: 'running' | 'completed' | 'interrupted' | 'error';
  artifactDirectory: string;
  trials: TrialResult[];
  statistics: RunStatistics;
  /** A clean threshold decision; requestedTrials remains the original budget. */
  decision?: { minFailures: number; outcome: 'reproduced' | 'not_reproduced'; completedTrials: number };
  error?: string;
  predicate?: FailurePredicate;
  environment?: EnvironmentSnapshot;
  /** Immutable source provenance for runs executed in temporary Git worktrees. */
  source?: { kind: 'git'; repository: string; commit: string; subdirectory: string };
}

export interface RunOptions {
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
  captureEnv?: string[];
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
}

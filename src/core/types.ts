export type TrialStatus = 'passed' | 'failed' | 'timed_out' | 'spawn_error' | 'interrupted';
export type TerminationReason = 'exit' | 'signal' | 'timeout' | 'spawn_error' | 'interrupted';

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
  timeoutMs: number;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'interrupted' | 'error';
  artifactDirectory: string;
  trials: TrialResult[];
  statistics: RunStatistics;
  error?: string;
}

export interface RunOptions {
  command: string;
  repeat?: number;
  timeoutMs?: number;
  cwd?: string;
  /** Parent directory for runs; defaults to cwd/.failtrace. */
  artifactsDir?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onTrialComplete?: (trial: TrialResult) => void;
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

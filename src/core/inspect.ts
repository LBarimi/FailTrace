import type { BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRun, safeArtifactPath } from './run-reader.js';
import { aggregateStatistics } from './statistics.js';
import type { RunStatistics, RunSummary, TrialResult, TrialStatus, TerminationReason } from './types.js';

export type RunEvidenceFilter = 'all' | 'matched' | 'unmatched' | 'unhealthy';
export type RunOutputStream = 'stdout' | 'stderr';

export interface InspectRunTrialsOptions {
  view: 'trials';
  run: string;
  cwd?: string;
  /** Return matching trials with a larger immutable trial index. Defaults to zero. */
  afterTrial?: number;
  /** Page size. Defaults to 20 and cannot exceed 40. */
  limit?: number;
  /** matched/unmatched require explicit predicate evidence; unhealthy selects invalid or interrupted execution evidence. */
  filter?: RunEvidenceFilter;
  signal?: AbortSignal;
}

export interface InspectRunOutputOptions {
  view: 'output';
  run: string;
  cwd?: string;
  trial: number;
  stream: RunOutputStream;
  /** Raw byte offset in the saved output. Defaults to zero. */
  offsetBytes?: number;
  /** Maximum bytes returned. Defaults to 16 KiB and cannot exceed 64 KiB. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export type InspectRunEvidenceOptions = InspectRunTrialsOptions | InspectRunOutputOptions;

export interface InspectedTrial {
  index: number;
  status: TrialStatus;
  failureMatched: boolean | null;
  unhealthy: boolean;
  exitCode: number | null;
  durationMs: number;
  terminationReason: TerminationReason;
  timedOut: boolean;
  spawningFailed: boolean;
  stdoutPath: string;
  stderrPath: string;
  error?: string;
}

export interface RunTrialPage {
  view: 'trials';
  runId: string;
  status: RunSummary['status'];
  artifactDirectory: string;
  metadataPath: string;
  requestedTrials: number;
  recordedTrials: number;
  matchedTrials: number;
  statistics: RunStatistics;
  filter: RunEvidenceFilter;
  afterTrial: number;
  limit: number;
  trials: InspectedTrial[];
  /** Last returned trial index when another matching trial exists in this snapshot. */
  nextAfterTrial: number | null;
}

export interface RunOutputChunk {
  view: 'output';
  runId: string;
  status: RunSummary['status'];
  trial: number;
  stream: RunOutputStream;
  path: string;
  /** Output is decoded with UTF-8 replacement semantics; offsets always address the original bytes. */
  encoding: 'utf8';
  totalBytes: number;
  offsetBytes: number;
  bytesRead: number;
  text: string;
  nextOffsetBytes: number | null;
  /** True when bytes before or after this chunk are omitted. */
  truncated: boolean;
}

export type InspectRunEvidenceResult = RunTrialPage | RunOutputChunk;

const DEFAULT_TRIAL_LIMIT = 20;
const MAX_TRIAL_LIMIT = 40;
const DEFAULT_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function positiveInteger(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a nonnegative' : 'a positive'} safe integer.`);
  }
}

function validateTrialOptions(options: InspectRunTrialsOptions): void {
  const afterTrial = options.afterTrial ?? 0;
  const limit = options.limit ?? DEFAULT_TRIAL_LIMIT;
  const filter = options.filter ?? 'all';
  positiveInteger(afterTrial, 'Trial cursor', true);
  positiveInteger(limit, 'Trial page limit');
  if (limit > MAX_TRIAL_LIMIT) throw new Error(`Trial page limit cannot exceed ${MAX_TRIAL_LIMIT}.`);
  if (!['all', 'matched', 'unmatched', 'unhealthy'].includes(filter)) throw new Error('Unknown trial filter.');
}

function validateOutputOptions(options: InspectRunOutputOptions): void {
  positiveInteger(options.trial, 'Trial index');
  if (!['stdout', 'stderr'].includes(options.stream)) throw new Error('Output stream must be stdout or stderr.');
  const offsetBytes = options.offsetBytes ?? 0;
  const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_BYTES;
  positiveInteger(offsetBytes, 'Output offset', true);
  positiveInteger(maxBytes, 'Output byte limit');
  if (maxBytes > MAX_OUTPUT_BYTES) throw new Error(`Output byte limit cannot exceed ${MAX_OUTPUT_BYTES}.`);
}

function matchingState(trial: TrialResult): boolean | null {
  return typeof trial.failureMatched === 'boolean' ? trial.failureMatched : null;
}

/** This is evidence health, not an opinion about which nonmatching exit codes are acceptable. */
function unhealthyTrial(trial: TrialResult, command: string): boolean {
  const matched = matchingState(trial);
  return trial.command !== command
    || trial.terminationReason !== 'exit'
    || trial.signal !== null
    || trial.timedOut !== false
    || trial.spawningFailed !== false
    || trial.error !== undefined
    || trial.exitCode === null
    || trial.exitCode < 0
    || matched === null
    || !['passed', 'failed'].includes(trial.status);
}

function includeTrial(trial: TrialResult, run: RunSummary, filter: RunEvidenceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'matched') return matchingState(trial) === true;
  if (filter === 'unmatched') return matchingState(trial) === false;
  return unhealthyTrial(trial, run.command);
}

function projectTrial(trial: TrialResult, run: RunSummary): InspectedTrial {
  const directory = `trials/${String(trial.index).padStart(3, '0')}`;
  return {
    index: trial.index,
    status: trial.status,
    failureMatched: matchingState(trial),
    unhealthy: unhealthyTrial(trial, run.command),
    exitCode: trial.exitCode,
    durationMs: trial.durationMs,
    terminationReason: trial.terminationReason,
    timedOut: trial.timedOut === true,
    spawningFailed: trial.spawningFailed === true,
    stdoutPath: `${directory}/stdout.txt`,
    stderrPath: `${directory}/stderr.txt`,
    ...(typeof trial.error === 'string' ? { error: trial.error } : {}),
  };
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function inspectOutput(run: RunSummary, options: InspectRunOutputOptions): Promise<RunOutputChunk> {
  const offsetBytes = options.offsetBytes ?? 0;
  const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_BYTES;

  const trial = run.trials.find((candidate) => candidate.index === options.trial);
  if (!trial) throw new Error(`Trial ${options.trial} does not exist.`);
  const relativePath = `trials/${String(trial.index).padStart(3, '0')}/${options.stream}.txt`;
  const recordedPath = options.stream === 'stdout' ? trial.stdoutPath : trial.stderrPath;
  if (recordedPath !== relativePath) throw new Error('Trial output path is not canonical.');
  const path = await safeArtifactPath(run.artifactDirectory, relativePath);
  options.signal?.throwIfAborted();

  const beforePath = await lstat(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error('Trial output must be a regular file.');
  const handle = await open(path, 'r');
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    if (!beforeHandle.isFile() || !sameFileSnapshot(beforePath, beforeHandle)) {
      throw new Error('Trial output changed before it could be inspected.');
    }
    if (beforeHandle.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Trial output is too large to inspect safely.');
    const totalBytes = Number(beforeHandle.size);
    if (offsetBytes > totalBytes) throw new Error('Output offset exceeds the saved output size.');
    const expectedBytes = Math.min(maxBytes, totalBytes - offsetBytes);
    const buffer = Buffer.alloc(expectedBytes);
    const bytesRead = expectedBytes === 0 ? 0 : (await handle.read(buffer, 0, expectedBytes, offsetBytes)).bytesRead;
    options.signal?.throwIfAborted();

    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }),
    ]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink()
      || !sameFileSnapshot(beforeHandle, afterHandle) || !sameFileSnapshot(beforeHandle, afterPath)
      || bytesRead !== expectedBytes) {
      throw new Error('Trial output changed while it was being inspected.');
    }
    options.signal?.throwIfAborted();
    const nextOffsetBytes = offsetBytes + bytesRead < totalBytes ? offsetBytes + bytesRead : null;
    return {
      view: 'output', runId: run.id, status: run.status, trial: trial.index, stream: options.stream,
      path: relativePath, encoding: 'utf8', totalBytes, offsetBytes, bytesRead,
      text: buffer.subarray(0, bytesRead).toString('utf8'), nextOffsetBytes,
      truncated: offsetBytes > 0 || nextOffsetBytes !== null,
    };
  } finally {
    await handle.close();
  }
}

/** Read bounded, already-recorded run evidence without executing the saved command. */
export async function inspectRunEvidence(options: InspectRunEvidenceOptions): Promise<InspectRunEvidenceResult> {
  const value = options as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Inspection options must be an object.');
  const input = value as Record<string, unknown>;
  if (input.view !== 'trials' && input.view !== 'output') throw new Error('Inspection view must be trials or output.');
  if (typeof input.run !== 'string' || !input.run.trim() || input.run.includes('\0')) throw new Error('Provide a run ID or path.');
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim() || input.cwd.includes('\0'))) {
    throw new Error('Inspection working directory must be a non-empty path.');
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new Error('Inspection signal must be an AbortSignal.');
  if (options.view === 'trials') validateTrialOptions(options);
  else validateOutputOptions(options);
  options.signal?.throwIfAborted();
  const run = await loadRun(options.run, options.cwd);
  options.signal?.throwIfAborted();
  if (options.view === 'output') return inspectOutput(run, options);

  const afterTrial = options.afterTrial ?? 0;
  const limit = options.limit ?? DEFAULT_TRIAL_LIMIT;
  const filter = options.filter ?? 'all';

  const orderedTrials = [...run.trials].sort((left, right) => left.index - right.index);
  const remaining = orderedTrials.filter((trial) => trial.index > afterTrial && includeTrial(trial, run, filter));
  const selected = remaining.slice(0, limit);
  return {
    view: 'trials', runId: run.id, status: run.status, artifactDirectory: run.artifactDirectory,
    metadataPath: join(run.artifactDirectory, 'run.json'), requestedTrials: run.requestedTrials,
    recordedTrials: run.trials.length,
    matchedTrials: run.trials.filter((trial) => matchingState(trial) === true).length,
    statistics: aggregateStatistics(run.trials), filter, afterTrial, limit,
    trials: selected.map((trial) => projectTrial(trial, run)),
    nextAfterTrial: remaining.length > limit ? selected.at(-1)!.index : null,
  };
}

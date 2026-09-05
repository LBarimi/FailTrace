import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { loadRun, safeArtifactPath } from './run-reader.js';
import { aggregateStatistics } from './statistics.js';
import type { RunStatistics, TrialResult } from './types.js';

export interface CompareOptions {
  runA: string;
  /** Omit to prefer a clean nonmatch and a recorded target match in runA. */
  runB?: string;
  trialA?: number;
  trialB?: number;
  cwd?: string;
  maxBytes?: number;
  maxLines?: number;
  signal?: AbortSignal;
}
export interface OutputComparison {
  equal: boolean;
  sha256A: string;
  sha256B: string;
  bytesA: number;
  bytesB: number;
  truncated: boolean;
  /** Bounded line-aligned evidence, with +/- markers when lines differ. */
  diff: string[];
}
export interface ComparisonResult {
  runA: string;
  runB: string;
  trialA: number;
  trialB: number;
  selectedTrials?: { a: ComparisonTrialEvidence; b: ComparisonTrialEvidence };
  warnings?: string[];
  commandChanged: boolean;
  concurrencyChanged: boolean;
  predicateChanged: boolean;
  executionRequirementChanged?: boolean;
  statisticsA: RunStatistics;
  statisticsB: RunStatistics;
  failureRateDelta: number;
  environmentChanges: { key: string; before: unknown; after: unknown }[];
  stdout: OutputComparison;
  stderr: OutputComparison;
}

export type ComparisonTrialEvidence = Pick<TrialResult, 'status' | 'exitCode' | 'terminationReason' | 'failureMatched' | 'executionMatched'>;

async function digest(path: string, signal?: AbortSignal): Promise<{ hash: string; size: number }> {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk);
    size += (chunk as Buffer).length;
  }
  return { hash: hash.digest('hex'), size };
}

async function prefix(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    signal?.throwIfAborted();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function compareOutput(a: string, b: string, maxBytes: number, maxLines: number, signal?: AbortSignal): Promise<OutputComparison> {
  const [first, second] = await Promise.all([digest(a, signal), digest(b, signal)]);
  const equal = first.hash === second.hash;
  const result: OutputComparison = {
    equal, sha256A: first.hash, sha256B: second.hash, bytesA: first.size, bytesB: second.size,
    truncated: false, diff: [],
  };
  if (equal) return result;
  const [textA, textB] = await Promise.all([prefix(a, maxBytes, signal), prefix(b, maxBytes, signal)]);
  const linesA = textA.split('\n');
  const linesB = textB.split('\n');
  result.truncated = first.size > maxBytes || second.size > maxBytes;
  let index = 0;
  for (; index < Math.max(linesA.length, linesB.length); index++) {
    const left = linesA[index];
    const right = linesB[index];
    const lines = left === right ? [` ${left ?? ''}`] : [
      ...(left === undefined ? [] : [`-${left}`]), ...(right === undefined ? [] : [`+${right}`]),
    ];
    if (result.diff.length + lines.length > maxLines) { result.truncated = true; break; }
    result.diff.push(...lines);
  }
  return result;
}

function selectTrial(trials: TrialResult[], index: number | undefined, desired: 'passed' | 'failed', requireExecution: boolean): TrialResult {
  const eligible = requireExecution ? trials.filter(trial => trial.executionMatched === true) : trials;
  const preferred = desired === 'failed'
    ? eligible.find((item) => item.failureMatched === true)
    : eligible.find((item) => item.status === 'passed' && item.terminationReason === 'exit' && item.exitCode === 0 && !item.error);
  const trial = index === undefined
    ? preferred ?? trials.find((item) => desired === 'passed' ? item.status === 'passed' : item.status !== 'passed')
    : trials.find((item) => item.index === index);
  if (!trial) throw new Error(index === undefined ? `Run has no ${desired} trial to compare.` : `Trial ${index} does not exist.`);
  return trial;
}

function trialEvidence(trial: TrialResult): ComparisonTrialEvidence {
  return { status: trial.status, exitCode: trial.exitCode, terminationReason: trial.terminationReason,
    ...(trial.executionMatched === undefined ? {} : { executionMatched: trial.executionMatched }),
    ...(trial.failureMatched === undefined ? {} : { failureMatched: trial.failureMatched }) };
}

function trialWarning(trial: TrialResult, label: string, requireExecution: boolean): string[] {
  if (requireExecution && trial.executionMatched !== true) return [`Trial ${label} lacks the required execution checkpoint; its target match or nonmatch is inconclusive.`];
  if (trial.terminationReason !== 'exit' || trial.error || trial.outputLimit) {
    return [`Trial ${label} is an incomplete or unhealthy execution (${trial.status}); do not interpret this difference as the target failure.`];
  }
  if (trial.failureMatched === undefined) return [`Trial ${label} has no recorded predicate match field; its legacy status alone does not identify the target.`];
  if (!trial.failureMatched && trial.exitCode !== 0) return [`Trial ${label} exited ${trial.exitCode} without matching the target; check for unrelated setup or test failures.`];
  return [];
}

export async function compareRuns(options: CompareOptions): Promise<ComparisonResult> {
  options.signal?.throwIfAborted();
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const maxLines = options.maxLines ?? 200;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024
    || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 10_000) throw new Error('Invalid comparison output limits.');
  for (const index of [options.trialA, options.trialB]) {
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 1)) throw new Error('Trial index must be positive.');
  }
  const first = await loadRun(options.runA, options.cwd);
  const second = options.runB === undefined ? first : await loadRun(options.runB, options.cwd);
  const trialA = selectTrial(first.trials, options.trialA ?? (options.runB ? first.trials[0]?.index : undefined), 'passed', first.executionRequirement !== undefined);
  const trialB = selectTrial(second.trials, options.trialB ?? (options.runB ? second.trials[0]?.index : undefined), 'failed', second.executionRequirement !== undefined);
  const paths = await Promise.all([
    safeArtifactPath(first.artifactDirectory, trialA.stdoutPath), safeArtifactPath(second.artifactDirectory, trialB.stdoutPath),
    safeArtifactPath(first.artifactDirectory, trialA.stderrPath), safeArtifactPath(second.artifactDirectory, trialB.stderrPath),
  ]);
  const [stdout, stderr] = await Promise.all([
    compareOutput(paths[0]!, paths[1]!, maxBytes, maxLines, options.signal),
    compareOutput(paths[2]!, paths[3]!, maxBytes, maxLines, options.signal),
  ]);
  const statisticsA = aggregateStatistics(first.trials);
  const statisticsB = aggregateStatistics(second.trials);
  const flattenEnvironment = (environment: typeof first.environment): Record<string, unknown> => ({
    platform: environment?.platform, arch: environment?.arch,
    nodeVersion: environment?.nodeVersion, shell: environment?.shell,
    ...Object.fromEntries(Object.entries(environment?.variables ?? {}).map(([key, value]) => [`variables.${key}`, value])),
  });
  const environmentA = flattenEnvironment(first.environment);
  const environmentB = flattenEnvironment(second.environment);
  const environmentChanges = [...new Set([...Object.keys(environmentA), ...Object.keys(environmentB)])].sort()
    .filter((key) => (environmentA as Record<string, unknown>)[key] !== (environmentB as Record<string, unknown>)[key])
    .map((key) => ({ key, before: (environmentA as Record<string, unknown>)[key] ?? null, after: (environmentB as Record<string, unknown>)[key] ?? null }));
  return {
    runA: first.id, runB: second.id, trialA: trialA.index, trialB: trialB.index,
    selectedTrials: { a: trialEvidence(trialA), b: trialEvidence(trialB) },
    warnings: [...trialWarning(trialA, 'A', first.executionRequirement !== undefined), ...trialWarning(trialB, 'B', second.executionRequirement !== undefined)],
    ...(first.executionRequirement === undefined && second.executionRequirement === undefined ? {} : {
      executionRequirementChanged: JSON.stringify(first.executionRequirement) !== JSON.stringify(second.executionRequirement),
    }),
    commandChanged: first.command !== second.command,
    concurrencyChanged: (first.concurrency ?? 1) !== (second.concurrency ?? 1),
    predicateChanged: JSON.stringify(first.predicate ?? { kind: 'nonzero_exit' }) !== JSON.stringify(second.predicate ?? { kind: 'nonzero_exit' }),
    statisticsA, statisticsB, failureRateDelta: statisticsB.failureRate - statisticsA.failureRate,
    environmentChanges, stdout, stderr,
  };
}

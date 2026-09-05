import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeJsonAtomic } from './artifacts.js';
import { runGit } from './git.js';
import { assessRun, validatePredicate } from './predicates.js';
import { DEFAULT_TIMEOUT_MS, runTrialsWithBudget, validateRunOptions, VERSION } from './run-trials.js';
import { OutputBudget, outputLimits, type OutputLimits } from './output-budget.js';
import type { ExecutionRequirement, FailurePredicate, RunSummary } from './types.js';
import { diagnosticMessage, MetadataBudget, MetadataLimitError, type MetadataLimit } from './metadata-budget.js';

export interface BisectOptions extends OutputLimits {
  command: string;
  good: string;
  bad: string;
  cwd?: string;
  repeat?: number;
  timeoutMs?: number;
  minFailures?: number;
  predicate?: FailurePredicate;
  executionRequirement?: ExecutionRequirement;
  /** Allowed exit codes for a completed nonmatching trial; defaults to [0]. */
  healthyExitCodes?: number[];
  /** These exits stop classification, even when the target predicate matches. */
  inconclusiveExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onCandidate?: (candidate: BisectCandidate) => void | Promise<void>;
}

/** Complete counts and settings; loadRun(metadataPath) retrieves individual trials. */
export interface BisectRunEvidence extends Omit<RunSummary, 'trials' | 'context'> {
  trialCount: number;
  matchedTrials: number;
  metadataPath: string;
}

export interface BisectCandidate {
  commit: string;
  role: 'good' | 'bad' | 'candidate';
  assessment: 'reproduced' | 'not_reproduced' | 'inconclusive';
  reason?: string;
  run: BisectRunEvidence;
}

export interface BisectResult extends OutputLimits {
  schemaVersion: 2;
  failtraceVersion: string;
  id: string;
  artifactDirectory: string;
  repository: string;
  cwd: string;
  command: string;
  good: string;
  bad: string;
  repeat: number;
  timeoutMs: number;
  minFailures: number;
  predicate?: FailurePredicate;
  executionRequirement?: ExecutionRequirement;
  healthyExitCodes?: number[];
  inconclusiveExitCodes?: number[];
  scope: 'first-parent';
  status: 'running' | 'found' | 'inconclusive' | 'interrupted' | 'error';
  startedAt: string;
  endedAt: string | null;
  firstBad: string | null;
  lastGood: string | null;
  candidates: BisectCandidate[];
  reason?: string;
  metadataLimit?: MetadataLimit;
  cleanupError?: string;
}

function validateOptions(options: BisectOptions): void {
  validateRunOptions({ ...options, repeat: options.repeat ?? 5 });
  validatePredicate(options.predicate);
  for (const key of ['good', 'bad'] as const) {
    if (typeof options[key] !== 'string' || options[key].trim() === '' || options[key].includes('\0')) {
      throw new Error(`${key} must be a non-empty Git revision without null bytes.`);
    }
  }
  const threshold = options.minFailures ?? 1;
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > (options.repeat ?? 5)) {
    throw new Error('minFailures must be a positive integer no greater than repeat.');
  }
}

function exitCodes(value: number[], name: string, allowEmpty = false): number[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256
    || value.some((code) => !Number.isSafeInteger(code) || code < 0 || code > 0xffff_ffff)) {
    throw new Error(`${name} must contain ${allowEmpty ? '0' : '1'} to 256 integer exit codes from 0 to 4294967295.`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function classifyCandidate(run: RunSummary, threshold: number, healthy: number[], inconclusive: number[]):
  Pick<BisectCandidate, 'assessment' | 'reason'> {
  const assessment = assessRun(run, threshold);
  if (assessment === 'inconclusive') return { assessment,
    ...(run.executionRequirement !== undefined && run.trials.some(trial => trial.executionMatched !== true)
      ? { reason: 'Required execution checkpoint is missing or unknown; check whether the intended check ran.' } : {}),
  };
  for (const trial of run.trials) {
    // assessRun has already checked that every recorded trial is a clean exit.
    const code = trial.exitCode!;
    if (inconclusive.includes(code)) return { assessment: 'inconclusive',
      reason: `Trial ${trial.index} exited ${code}, declared inconclusive; no boundary is claimed.` };
    if (!trial.failureMatched && !healthy.includes(code)) return { assessment: 'inconclusive',
      reason: `Trial ${trial.index} exited ${code} without matching the target. Expected a healthy exit (${healthy.join(', ')}). Check setup or unrelated failures before retrying.` };
  }
  return { assessment };
}

/** Check the exact generated target before destructive Git worktree operations. */
async function assertOwnedWorktree(artifactDirectory: string, worktree: string): Promise<void> {
  if (relative(artifactDirectory, worktree) !== 'worktree') {
    throw new Error('Refusing to modify a worktree outside this bisect artifact directory.');
  }
  const info = await lstat(worktree);
  if (!info.isDirectory() || info.isSymbolicLink()
    || dirname(await realpath(worktree)) !== await realpath(artifactDirectory)) {
    throw new Error('Refusing to modify a replaced or redirected bisect worktree.');
  }
}

/**
 * Locate the sampled failure boundary on bad's first-parent history. The search
 * assumes failure is monotonic along that history; it is not a confidence test.
 */
export async function bisectRegression(options: BisectOptions): Promise<BisectResult> {
  options = { ...options, ...(options.executionRequirement === undefined ? {} : { executionRequirement: { ...options.executionRequirement } }) };
  validateOptions(options);
  const healthy = exitCodes(options.healthyExitCodes ?? [0], 'healthyExitCodes');
  const inconclusive = exitCodes(options.inconclusiveExitCodes ?? [], 'inconclusiveExitCodes', true);
  if (healthy.some((code) => inconclusive.includes(code))) throw new Error('Healthy and inconclusive exit codes must not overlap.');
  const limits = outputLimits(options);
  const outputBudget = new OutputBudget(limits.maxTotalOutputBytes);
  const metadata = new MetadataBudget();
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  // Resolve the repository without the caller's abort signal so even a
  // pre-cancelled invocation can persist a valid interrupted report.
  const repository = await realpath(resolve(await runGit(cwd, ['rev-parse', '--show-toplevel'])));
  const subdirectory = relative(repository, cwd);
  if (isAbsolute(subdirectory) || subdirectory === '..' || subdirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Working directory must be inside the Git working tree.');
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const parent = join(repository, '.failtrace', 'bisects');
  await mkdir(parent, { recursive: true });
  const artifactDirectory = join(parent, id);
  await mkdir(artifactDirectory);
  const worktree = join(artifactDirectory, 'worktree');
  const result: BisectResult = {
    schemaVersion: 2,
    ...limits,
    failtraceVersion: VERSION,
    id,
    artifactDirectory,
    repository,
    cwd,
    command: options.command,
    good: options.good,
    bad: options.bad,
    repeat: options.repeat ?? 5,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    minFailures: options.minFailures ?? 1,
    healthyExitCodes: healthy,
    inconclusiveExitCodes: inconclusive,
    ...(options.predicate === undefined ? {} : { predicate: options.predicate }),
    ...(options.executionRequirement === undefined ? {} : { executionRequirement: { ...options.executionRequirement } }),
    scope: 'first-parent',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    firstBad: null,
    lastGood: null,
    candidates: [],
  };
  const metadataPath = join(artifactDirectory, 'bisect.json');
  await writeJsonAtomic(metadataPath, result);
  const gitOptions = options.signal === undefined ? {} : { signal: options.signal };
  let worktreeAttempted = false;
  const interrupted = (): boolean => {
    if (!options.signal?.aborted) return false;
    result.status = 'interrupted';
    result.reason = 'Search interrupted; completed candidate evidence has been preserved.';
    return true;
  };
  const evaluate = async (commit: string, role: BisectCandidate['role']): Promise<BisectCandidate> => {
    await assertOwnedWorktree(artifactDirectory, worktree);
    // Candidate commands can change tracked and untracked files. Restore only
    // this generated worktree before evaluating the next immutable commit.
    await runGit(worktree, ['reset', '--hard', commit], gitOptions);
    await runGit(worktree, ['clean', '-ffdx'], gitOptions);
    const run = await runTrialsWithBudget({
      ...limits,
      command: result.command,
      cwd: join(worktree, subdirectory),
      repeat: result.repeat,
      stopWhenDecided: { minFailures: result.minFailures },
      timeoutMs: result.timeoutMs,
      artifactsDir: join(artifactDirectory, 'evidence'),
      ...(options.predicate === undefined ? {} : { predicate: options.predicate }),
      ...(result.executionRequirement === undefined ? {} : { executionRequirement: result.executionRequirement }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, outputBudget, metadata, { kind: 'git', repository, commit, subdirectory: subdirectory.replaceAll('\\', '/') });
    const { trials, context: _context, ...runMetadata } = run;
    if (run.metadataLimit) result.metadataLimit = run.metadataLimit;
    const candidate: BisectCandidate = {
      commit, role, ...classifyCandidate(run, result.minFailures, healthy, inconclusive),
      run: { ...runMetadata, trialCount: trials.length, matchedTrials: trials.filter((trial) => trial.failureMatched === true).length,
        metadataPath: join(run.artifactDirectory, 'run.json') },
    };
    result.candidates.push(candidate);
    await writeJsonAtomic(metadataPath, result);
    await options.onCandidate?.(structuredClone(candidate));
    return candidate;
  };

  try {
    if (interrupted()) return result;
    result.good = await runGit(repository, ['rev-parse', '--verify', '--end-of-options', `${options.good}^{commit}`], gitOptions);
    result.bad = await runGit(repository, ['rev-parse', '--verify', '--end-of-options', `${options.bad}^{commit}`], gitOptions);
    if (result.good === result.bad) {
      result.status = 'inconclusive';
      result.reason = 'Good and bad resolve to the same commit.';
      return result;
    }
    const output = await runGit(repository, ['rev-list', '--first-parent', '--reverse', `${result.good}..${result.bad}`], gitOptions);
    const commits = output === '' ? [] : output.split(/\r?\n/);
    const oldest = commits[0];
    const parents = oldest === undefined ? '' : await runGit(repository,
      ['rev-list', '--parents', '-n', '1', oldest], gitOptions);
    const previous = parents.split(' ')[1];
    if (oldest === undefined || previous !== result.good) {
      if (interrupted()) return result;
      result.status = 'inconclusive';
      result.reason = 'Good must be an ancestor of bad on its first-parent history. Merge side branches are outside this search scope.';
      return result;
    }
    const history = [result.good, ...commits];
    worktreeAttempted = true;
    await runGit(repository, ['worktree', 'add', '--detach', worktree, result.good], gitOptions);

    const good = await evaluate(result.good, 'good');
    if (interrupted()) return result;
    if (good.assessment !== 'not_reproduced') {
      result.status = 'inconclusive';
      result.reason = good.assessment === 'reproduced'
        ? 'The supplied good commit reproduces the failure at the configured threshold.'
        : good.reason ?? 'The supplied good commit could not be classified from valid trial evidence.';
      return result;
    }
    result.lastGood = result.good;
    const bad = await evaluate(result.bad, 'bad');
    if (interrupted()) return result;
    if (bad.assessment !== 'reproduced') {
      result.status = 'inconclusive';
      result.reason = bad.assessment === 'not_reproduced'
        ? 'The supplied bad commit does not reproduce the failure at the configured threshold.'
        : bad.reason ?? 'The supplied bad commit could not be classified from valid trial evidence.';
      return result;
    }

    let low = 0;
    let high = history.length - 1;
    while (high - low > 1) {
      if (interrupted()) return result;
      const middle = Math.floor((low + high) / 2);
      const commit = history[middle];
      if (commit === undefined) throw new Error('Missing commit in first-parent history.');
      const candidate = await evaluate(commit, 'candidate');
      if (interrupted()) return result;
      if (candidate.assessment === 'inconclusive') {
        result.status = 'inconclusive';
        result.reason = `Commit ${commit} could not be classified from valid trial evidence; no culprit is claimed.${candidate.reason ? ` ${candidate.reason}` : ''}`;
        return result;
      }
      if (candidate.assessment === 'reproduced') high = middle;
      else {
        low = middle;
        result.lastGood = commit;
      }
    }
    result.status = 'found';
    result.firstBad = history[high] ?? null;
    result.lastGood = history[low] ?? null;
    result.reason = 'Sampled failure boundary found on first-parent history, assuming a monotonic failure threshold.';
    return result;
  } catch (error) {
    if (!interrupted()) {
      result.status = error instanceof MetadataLimitError ? 'inconclusive' : 'error';
      if (error instanceof MetadataLimitError) result.metadataLimit = error.details;
      result.reason = diagnosticMessage(error);
    }
    return result;
  } finally {
    if (worktreeAttempted) {
      try {
        await assertOwnedWorktree(artifactDirectory, worktree);
        // Cleanup must still run after cancellation, using a fresh bounded Git
        // call. Never prune or remove another worktree's registration.
        await runGit(repository, ['worktree', 'remove', '--force', '--force', worktree], { timeoutMs: 10_000 });
      } catch (error) {
        result.cleanupError = `Temporary worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    result.endedAt = new Date().toISOString();
    await writeJsonAtomic(metadataPath, result);
  }
}

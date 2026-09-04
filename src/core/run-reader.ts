import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validatePredicate } from './predicates.js';
import type { RunSummary, TrialResult } from './types.js';

/** Resolve a referenced artifact without accepting escapes or symbolic links. */
export async function safeArtifactPath(directory: string, path: string): Promise<string> {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\0')) {
    throw new Error('Artifact path must be a relative path.');
  }
  const segments = path.replaceAll('\\', '/').split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe artifact path.');
  const root = await realpath(directory);
  let target = root;
  for (const segment of segments) {
    target = join(target, segment);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Artifact symbolic links are not supported.');
  }
  const fromRoot = relative(root, await realpath(target));
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Artifact path escapes its run directory.');
  }
  return target;
}

function validateTrial(value: unknown): asserts value is TrialResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid trial metadata.');
  const trial = value as TrialResult;
  if (!Number.isSafeInteger(trial.index) || trial.index < 1 || typeof trial.command !== 'string'
    || !Number.isFinite(trial.durationMs) || trial.durationMs < 0
    || !['passed', 'failed', 'timed_out', 'spawn_error', 'interrupted'].includes(trial.status)
    || typeof trial.stdoutPath !== 'string' || typeof trial.stderrPath !== 'string'
    || !['exit', 'signal', 'timeout', 'spawn_error', 'interrupted'].includes(trial.terminationReason)
    || (trial.exitCode !== null && !Number.isSafeInteger(trial.exitCode))) {
    throw new Error('Invalid trial metadata.');
  }
}

/** Load an ID, run directory, or run.json, relocating file references to its actual directory. */
export async function loadRun(reference: string, cwd = process.cwd()): Promise<RunSummary> {
  if (typeof reference !== 'string' || !reference.trim() || reference.includes('\0')) throw new Error('Provide a run ID or path.');
  let path = resolve(cwd, reference);
  let info;
  try { info = await stat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !/^[\w.-]+$/.test(reference)) throw error;
    path = resolve(cwd, '.failtrace', 'runs', reference);
    info = await stat(path);
  }
  if (info.isDirectory()) path = join(path, 'run.json');
  path = await realpath(path);
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('Run metadata exceeds the 32 MiB reader limit.');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid run metadata.');
  const run = value as RunSummary;
  if (run.schemaVersion !== 1 || typeof run.id !== 'string' || typeof run.command !== 'string'
    || typeof run.cwd !== 'string' || !Array.isArray(run.trials)
    || !Number.isSafeInteger(run.requestedTrials) || run.requestedTrials < 1
    || !Number.isSafeInteger(run.timeoutMs) || run.timeoutMs < 1 || run.timeoutMs > 2_147_483_647
    || !['running', 'completed', 'interrupted', 'error'].includes(run.status)
    || !run.statistics || !Number.isFinite(run.statistics.failureRate)) {
    throw new Error('Invalid or unsupported run metadata.');
  }
  validatePredicate(run.predicate);
  const indices = new Set<number>();
  for (const trial of run.trials) {
    validateTrial(trial);
    if (indices.has(trial.index)) throw new Error('Run contains duplicate trial indices.');
    indices.add(trial.index);
  }
  run.artifactDirectory = dirname(path);
  return run;
}

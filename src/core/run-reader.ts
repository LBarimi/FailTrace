import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validatePredicate } from './predicates.js';
import { validateExecutionRequirement } from './execution-evidence.js';
import { MAX_METADATA_BYTES, type StoredRunSummary } from './run-metadata.js';
import { aggregateStatistics } from './statistics.js';
import type { RunSummary, TrialResult } from './types.js';
import { outputLimits } from './output-budget.js';
import { readBoundedFile } from './bounded-file.js';
import { MAX_INVESTIGATION_METADATA_BYTES, MAX_RECORDED_TRIALS } from './metadata-budget.js';
import { validateCommand } from './command.js';

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
  validateCommand(trial.command, trial.args);
  if (trial.executionMatched !== undefined && typeof trial.executionMatched !== 'boolean') throw new Error('Invalid execution evidence metadata.');
  if (!Number.isSafeInteger(trial.index) || trial.index < 1 || typeof trial.command !== 'string'
    || !Number.isFinite(trial.durationMs) || trial.durationMs < 0
    || !['passed', 'failed', 'timed_out', 'spawn_error', 'interrupted', 'resource_limited', 'output_error'].includes(trial.status)
    || typeof trial.stdoutPath !== 'string' || typeof trial.stderrPath !== 'string'
    || !['exit', 'signal', 'timeout', 'spawn_error', 'interrupted', 'output_limit', 'output_error'].includes(trial.terminationReason)
    || (trial.exitCode !== null && !Number.isSafeInteger(trial.exitCode))) {
    throw new Error('Invalid trial metadata.');
  }
  if (trial.outputLimit !== undefined && (!trial.outputLimit || !['trial', 'experiment'].includes(trial.outputLimit.scope)
    || !Number.isSafeInteger(trial.outputLimit.limitBytes) || trial.outputLimit.limitBytes < 1)) {
    throw new Error('Invalid output limit metadata.');
  }
}

/** Load an ID, run directory, or run.json, relocating file references to its actual directory. */
export async function loadRun(reference: string, cwd = process.cwd(), signal?: AbortSignal): Promise<RunSummary> {
  signal?.throwIfAborted();
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
  if ((await stat(path)).size > MAX_METADATA_BYTES) throw new Error('Run metadata exceeds the 32 MiB reader limit.');
  const header = await readBoundedFile(path, MAX_METADATA_BYTES, signal);
  signal?.throwIfAborted();
  let totalMetadataBytes = header.length;
  const value: unknown = JSON.parse(header.toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid run metadata.');
  const run = value as StoredRunSummary;
  validateCommand(run.command, run.args);
  if (![1, 2].includes(run.schemaVersion) || (run.schemaVersion === 2 && run.trialStorage !== 'individual')
    || (run.schemaVersion === 1 && run.trialStorage !== undefined)
    || typeof run.id !== 'string' || typeof run.command !== 'string'
    || typeof run.cwd !== 'string' || !Array.isArray(run.trials)
    || !Number.isSafeInteger(run.requestedTrials) || run.requestedTrials < 1
    || (run.concurrency !== undefined && (!Number.isSafeInteger(run.concurrency) || run.concurrency < 1))
    || !Number.isSafeInteger(run.timeoutMs) || run.timeoutMs < 1 || run.timeoutMs > 2_147_483_647
    || !['running', 'completed', 'interrupted', 'error', 'resource_limited'].includes(run.status)
    || !run.statistics || !Number.isFinite(run.statistics.failureRate)) {
    throw new Error('Invalid or unsupported run metadata.');
  }
  validatePredicate(run.predicate);
  if (run.executionRequirement !== undefined) validateExecutionRequirement(run.executionRequirement);
  outputLimits(run);
  if (run.trials.length > MAX_RECORDED_TRIALS || (run.trialCount ?? 0) > MAX_RECORDED_TRIALS) {
    throw new Error('Run exceeds the 100000 recorded trial reader limit.');
  }
  if (run.metadataLimit !== undefined && (!run.metadataLimit || typeof run.metadataLimit !== 'object'
    || !['limitBytes', 'usedBytes', 'reservedBytes', 'requiredBytes'].every((key) => {
      const value = run.metadataLimit![key as keyof NonNullable<RunSummary['metadataLimit']>];
      return Number.isSafeInteger(value) && value >= (key === 'limitBytes' || key === 'requiredBytes' ? 1 : 0);
    }))) throw new Error('Invalid metadata allowance evidence.');
  run.artifactDirectory = dirname(path);
  if (run.trialStorage !== undefined) {
    if (run.trialStorage !== 'individual' || run.trials.length !== 0
      || ((run.status === 'completed' || run.status === 'interrupted' || run.trialCount !== undefined)
        && (!Number.isSafeInteger(run.trialCount) || run.trialCount! < 0 || run.trialCount! > run.requestedTrials))) {
      throw new Error('Invalid individual trial metadata.');
    }
    let trialsDirectory: string | undefined;
    try { trialsDirectory = await safeArtifactPath(run.artifactDirectory, 'trials'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (trialsDirectory) {
      let entries = 0;
      for await (const entry of await opendir(trialsDirectory)) {
        signal?.throwIfAborted();
        if (++entries > MAX_RECORDED_TRIALS) throw new Error('Run exceeds the 100000 trial directory-entry reader limit.');
        if (!/^\d+$/.test(entry.name)) continue;
        const index = Number(entry.name);
        if (!Number.isSafeInteger(index) || index < 1 || index > run.requestedTrials
          || entry.name !== String(index).padStart(3, '0') || !entry.isDirectory()) {
          throw new Error('Invalid or redirected trial directory.');
        }
        let trialPath: string;
        try { trialPath = await safeArtifactPath(run.artifactDirectory, `trials/${entry.name}/result.json`); } catch (error) {
          // An active/crashed process may have logs but no atomic result yet.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && run.status !== 'completed') continue;
          throw error;
        }
        const trialInfo = await stat(trialPath);
        if (!trialInfo.isFile() || trialInfo.size > MAX_METADATA_BYTES) throw new Error('Invalid or oversized trial metadata.');
        if (trialInfo.size > MAX_INVESTIGATION_METADATA_BYTES - totalMetadataBytes) {
          throw new Error('Run metadata reconstruction exceeds the 96 MiB aggregate limit.');
        }
        const bytes = await readBoundedFile(trialPath, Math.min(MAX_METADATA_BYTES, MAX_INVESTIGATION_METADATA_BYTES - totalMetadataBytes), signal);
        totalMetadataBytes += bytes.length;
        const trial: unknown = JSON.parse(bytes.toString('utf8'));
        validateTrial(trial);
        if (trial.index !== index || trial.stdoutPath !== `trials/${entry.name}/stdout.txt`
          || trial.stderrPath !== `trials/${entry.name}/stderr.txt`) throw new Error('Trial record does not match its directory.');
        run.trials.push(trial);
      }
    }
    run.trials.sort((a, b) => a.index - b.index);
    if (run.trialCount !== undefined && run.trials.length !== run.trialCount) throw new Error('Run is missing committed trial records.');
    delete run.trialStorage;
    delete run.trialCount;
  }
  const indices = new Set<number>();
  for (const trial of run.trials) {
    signal?.throwIfAborted();
    validateTrial(trial);
    if (indices.has(trial.index)) throw new Error('Run contains duplicate trial indices.');
    if (trial.index > run.requestedTrials) throw new Error('Trial index exceeds the requested budget.');
    indices.add(trial.index);
  }
  // Embedded summaries can also be stale after a producer crashes or edits a
  // record. Both storage schemas derive counts from their actual trial evidence.
  run.statistics = aggregateStatistics(run.trials);
  return { ...run, schemaVersion: 1 };
}

import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRunDirectory, writeJsonAtomic } from './artifacts.js';
import { runTrial } from './runner.js';
import { aggregateStatistics } from './statistics.js';
import type { RunOptions, RunSummary } from './types.js';

export const VERSION = '0.1.0';
export const DEFAULT_REPEAT = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;

export function validateRunOptions(options: RunOptions): void {
  if (typeof options.command !== 'string' || options.command.trim().length === 0 || options.command.includes('\0')) {
    throw new Error('Command must be a non-empty string without null bytes.');
  }
  const repeat = options.repeat ?? DEFAULT_REPEAT;
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error('Repeat must be a positive safe integer.');
  }
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new Error('Timeout must be a positive integer from 1 to 2147483647 milliseconds.');
  }
}

/** Run sequential trials; target failures are results, infrastructure failures reject. */
export async function runTrials(options: RunOptions): Promise<RunSummary> {
  validateRunOptions(options);
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
  const artifactsDir = resolve(cwd, options.artifactsDir ?? '.failtrace');
  const { id, directory } = await createRunDirectory(artifactsDir);
  const summary: RunSummary = {
    schemaVersion: 1,
    failtraceVersion: VERSION,
    id,
    command: options.command,
    cwd,
    requestedTrials: options.repeat ?? DEFAULT_REPEAT,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    artifactDirectory: directory,
    trials: [],
    statistics: aggregateStatistics([]),
  };
  const metadataPath = join(directory, 'run.json');
  await writeJsonAtomic(metadataPath, summary);
  try {
    for (let index = 1; index <= summary.requestedTrials; index++) {
      if (options.signal?.aborted) break;
      const trial = await runTrial({
        index,
        command: summary.command,
        cwd,
        timeoutMs: summary.timeoutMs,
        runDirectory: directory,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      summary.trials.push(trial);
      summary.statistics = aggregateStatistics(summary.trials);
      await writeJsonAtomic(join(directory, dirname(trial.stdoutPath), 'result.json'), trial);
      await writeJsonAtomic(metadataPath, summary);
      options.onTrialComplete?.(trial);
      if (trial.status === 'interrupted') break;
    }
    summary.status = options.signal?.aborted || summary.trials.some((trial) => trial.status === 'interrupted')
      ? 'interrupted'
      : 'completed';
  } catch (error) {
    summary.status = 'error';
    summary.error = error instanceof Error ? error.message : String(error);
    throw new Error(`Run failed: ${summary.error}\nArtifacts: ${directory}`, { cause: error });
  } finally {
    summary.endedAt = new Date().toISOString();
    await writeJsonAtomic(metadataPath, summary);
  }
  return summary;
}

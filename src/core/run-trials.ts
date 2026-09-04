import { stat } from 'node:fs/promises';
import { setMaxListeners } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { createRunDirectory, writeJsonAtomic } from './artifacts.js';
import { runTrial } from './runner.js';
import { aggregateStatistics, createStatisticsAccumulator } from './statistics.js';
import { writeRunSummary } from './run-metadata.js';
import { captureEnvironment } from './environment.js';
import { DEFAULT_PREDICATE, matchesFailure, validatePredicate } from './predicates.js';
import type { RunOptions, RunSummary } from './types.js';

export const VERSION = '0.4.0';
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
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive safe integer.');
  }
  if (options.stopWhenDecided !== undefined) {
    const threshold = options.stopWhenDecided.minFailures;
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > repeat) {
      throw new Error('Decision minFailures must be between one and repeat.');
    }
    if (concurrency !== 1) throw new Error('Decision stopping requires concurrency one.');
  }
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new Error('Timeout must be a positive integer from 1 to 2147483647 milliseconds.');
  }
  validatePredicate(options.predicate);
  captureEnvironment(options.captureEnv, options.env);
}

/** Sequential by default; bounded parallelism is explicit and evidence remains index ordered. */
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
    concurrency: options.concurrency ?? 1,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    artifactDirectory: directory,
    trials: [],
    statistics: aggregateStatistics([]),
    predicate: options.predicate ?? DEFAULT_PREDICATE,
    environment: captureEnvironment(options.captureEnv, options.env),
  };
  await writeRunSummary(summary);
  const controller = new AbortController();
  // This signal is owned by this run and has one listener per active process.
  setMaxListeners(0, controller.signal);
  const interrupt = (): void => controller.abort();
  options.signal?.addEventListener('abort', interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  const statistics = createStatisticsAccumulator();
  let nextIndex = 1;
  let matched = 0;
  let stopScheduling = false;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    try {
      while (!controller.signal.aborted && !stopScheduling && nextIndex <= summary.requestedTrials) {
        const index = nextIndex++;
        const trial = await runTrial({
          index,
          command: summary.command,
          cwd,
          timeoutMs: summary.timeoutMs,
          runDirectory: directory,
          ...(options.env === undefined ? {} : { env: options.env }),
          signal: controller.signal,
        });
        summary.trials.push(trial);
        let predicateError: unknown;
        try {
          trial.failureMatched = await matchesFailure(trial, directory, summary.predicate);
          if (trial.terminationReason === 'exit' && !trial.spawningFailed) {
            trial.status = trial.failureMatched ? 'failed' : 'passed';
          }
        } catch (error) {
          predicateError = error;
          trial.error = `Failure predicate evaluation failed: ${String(error)}`;
        }
        statistics.add(trial);
        summary.statistics = statistics.snapshot();
        await writeJsonAtomic(join(directory, dirname(trial.stdoutPath), 'result.json'), trial);
        if (predicateError) throw predicateError;
        await options.onTrialComplete?.({ ...trial });
        if (trial.status === 'interrupted') { stopScheduling = true; controller.abort(); }
        if (options.stopWhenDecided !== undefined && !controller.signal.aborted) {
          if (trial.terminationReason !== 'exit' || trial.spawningFailed || trial.error) {
            stopScheduling = true; // An infrastructure outcome cannot justify classification.
          } else {
            if (trial.failureMatched) matched++;
            const minFailures = options.stopWhenDecided.minFailures;
            const remaining = summary.requestedTrials - summary.trials.length;
            const outcome = matched >= minFailures ? 'reproduced'
              : matched + remaining < minFailures ? 'not_reproduced' : undefined;
            if (outcome) {
              summary.decision = { minFailures, outcome, completedTrials: summary.trials.length };
              stopScheduling = true;
            }
          }
        }
      }
    } catch (error) {
      if (!failed) { failed = true; firstError = error; }
      stopScheduling = true;
      controller.abort();
    }
  };
  try {
    // Workers absorb errors so all active trials finish cleanup and durable
    // persistence before the terminal summary (or caller rejection) is exposed.
    await Promise.all(Array.from({ length: Math.min(summary.concurrency!, summary.requestedTrials) }, worker));
    if (failed) throw firstError;
    summary.status = options.signal?.aborted || summary.trials.some((trial) => trial.status === 'interrupted')
      ? 'interrupted'
      : 'completed';
  } catch (error) {
    summary.status = 'error';
    delete summary.decision;
    summary.error = error instanceof Error ? error.message : String(error);
    throw new Error(`Run failed: ${summary.error}\nArtifacts: ${directory}`, { cause: error });
  } finally {
    options.signal?.removeEventListener('abort', interrupt);
    summary.trials.sort((a, b) => a.index - b.index);
    summary.statistics = aggregateStatistics(summary.trials);
    summary.endedAt = new Date().toISOString();
    await writeRunSummary(summary);
  }
  return summary;
}

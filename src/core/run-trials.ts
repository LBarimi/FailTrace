import { realpath, stat } from 'node:fs/promises';
import { setMaxListeners } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { createRunDirectory, writeTextAtomic } from './artifacts.js';
import { runTrial } from './runner.js';
import { validateCommand } from './command.js';
import { aggregateStatistics, createStatisticsAccumulator } from './statistics.js';
import { writeRunSummary } from './run-metadata.js';
import { captureEnvironment, effectiveEnvironment } from './environment.js';
import { DEFAULT_PREDICATE, matchesFailure, validatePredicate } from './predicates.js';
import { matchesExecution, validateExecutionRequirement } from './execution-evidence.js';
import { captureContext, contextDeclaration, snapshotsEqual } from './verify-context.js';
import type { RunOptions, RunSummary } from './types.js';
import { OutputBudget, outputLimits } from './output-budget.js';
import { diagnosticMessage, MAX_CONCURRENCY, MAX_METADATA_BYTES, MAX_RECORDED_TRIALS,
  MetadataBudget, MetadataLimitError, trialMetadataAllowance } from './metadata-budget.js';

export const VERSION = '1.2.0';
export const DEFAULT_REPEAT = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;

export function validateRunOptions(options: RunOptions): void {
  validateCommand(options.command, options.args);
  const repeat = options.repeat ?? DEFAULT_REPEAT;
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > MAX_RECORDED_TRIALS) {
    throw new Error('Repeat must be a positive safe integer no greater than 100000.');
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error('Concurrency must be a positive safe integer no greater than 64.');
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
  if (options.executionRequirement !== undefined) validateExecutionRequirement(options.executionRequirement);
  outputLimits(options);
  captureEnvironment(options.captureEnv, options.env);
  if (options.captureContext !== undefined) contextDeclaration(options.captureContext);
}

/** Sequential by default; bounded parallelism is explicit and evidence remains index ordered. */
export async function runTrials(options: RunOptions): Promise<RunSummary> {
  return runTrialsWithBudget(options, new OutputBudget(outputLimits(options).maxTotalOutputBytes));
}

/** Internal: investigations share output and metadata allowances across candidate runs. */
export async function runTrialsWithBudget(options: RunOptions, budget: OutputBudget, metadata = new MetadataBudget(), source?: RunSummary['source']): Promise<RunSummary> {
  validateRunOptions(options);
  metadata.reserve(MAX_METADATA_BYTES);
  const header = { bytes: 0 };
  try { return await executeRun(options, budget, metadata, header, source); }
  finally { metadata.commit(MAX_METADATA_BYTES, header.bytes); }
}

async function executeRun(options: RunOptions, budget: OutputBudget, metadata: MetadataBudget, header: { bytes: number }, source?: RunSummary['source']): Promise<RunSummary> {
  options = { ...options,
    ...(options.args === undefined ? {} : { args: [...options.args] }),
    ...(options.predicate === undefined ? {} : { predicate: structuredClone(options.predicate) }),
    ...(options.executionRequirement === undefined ? {} : { executionRequirement: { ...options.executionRequirement } }),
    ...(options.captureContext === undefined ? {} : { captureContext: contextDeclaration(options.captureContext) }),
    ...(options.captureEnv === undefined ? {} : { captureEnv: [...options.captureEnv] }),
    ...(options.stopWhenDecided === undefined ? {} : { stopWhenDecided: { ...options.stopWhenDecided } }),
  };
  // Context-enabled experiments pin the effective environment before any await.
  // Keep ordinary run behavior unchanged and never persist this ambient snapshot.
  const executionEnv = options.captureContext === undefined ? options.env : effectiveEnvironment(options.env);
  const capturedKeys = [...(options.captureEnv ?? [])];
  if (executionEnv && options.captureContext !== undefined) {
    for (const key of capturedKeys) {
      const actual = Object.keys(executionEnv).find((entry) => process.platform === 'win32' ? entry.toUpperCase() === key.toUpperCase() : entry === key);
      if (actual === undefined) executionEnv[key] = undefined;
    }
  }
  const declaration = options.captureContext === undefined ? undefined : contextDeclaration(options.captureContext);
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
  const artifactsDir = resolve(cwd, options.artifactsDir ?? '.failtrace');
  const { id, directory } = await createRunDirectory(artifactsDir);
  const summary: RunSummary = {
    schemaVersion: 1,
    failtraceVersion: VERSION,
    id,
    command: options.command,
    ...(options.args === undefined ? {} : { args: [...options.args] }),
    cwd,
    requestedTrials: options.repeat ?? DEFAULT_REPEAT,
    concurrency: options.concurrency ?? 1,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...outputLimits(options),
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    artifactDirectory: directory,
    trials: [],
    statistics: aggregateStatistics([]),
    predicate: structuredClone(options.predicate ?? DEFAULT_PREDICATE),
    ...(options.executionRequirement === undefined ? {} : { executionRequirement: { ...options.executionRequirement } }),
    environment: captureEnvironment(capturedKeys, executionEnv),
    ...(source === undefined ? {} : { source: { ...source } }),
  };
  const persistHeader = async (): Promise<void> => { header.bytes = await writeRunSummary(summary); };
  await persistHeader();
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
    let reservation = 0;
    try {
      while (!controller.signal.aborted && !stopScheduling && nextIndex <= summary.requestedTrials) {
        const allowance = trialMetadataAllowance(summary.command, summary.args);
        try { metadata.reserve(allowance); } catch (error) {
          if (!(error instanceof MetadataLimitError)) throw error;
          summary.metadataLimit = error.details;
          delete summary.decision;
          stopScheduling = true;
          return;
        }
        reservation = allowance;
        const index = nextIndex++;
        const trial = await runTrial({
          index,
          command: summary.command,
          ...(summary.predicate === undefined ? {} : { predicate: summary.predicate }),
          ...(summary.executionRequirement === undefined ? {} : { executionRequirement: summary.executionRequirement }),
          ...(summary.args === undefined ? {} : { args: summary.args }),
          cwd,
          timeoutMs: summary.timeoutMs,
          runDirectory: directory,
          ...(executionEnv === undefined ? {} : { env: executionEnv }),
          signal: controller.signal,
          maxOutputBytes: summary.maxOutputBytes!,
          outputBudget: budget,
        });
        summary.trials.push(trial);
        let predicateError: unknown;
        try {
          // Fresh captures supply substring results; saved evidence is still read and rechecked by Verify.
          trial.failureMatched ??= await matchesFailure(trial, directory, summary.predicate);
          if (summary.executionRequirement !== undefined) {
            trial.executionMatched ??= await matchesExecution(trial, directory, summary.executionRequirement);
          }
          if (trial.terminationReason === 'exit' && !trial.spawningFailed) {
            trial.status = trial.failureMatched ? 'failed' : 'passed';
          }
        } catch (error) {
          predicateError = error;
          trial.error = `Failure or execution evidence evaluation failed: ${String(error)}`;
        }
        if (trial.error !== undefined) trial.error = diagnosticMessage(trial.error);
        statistics.add(trial);
        summary.statistics = statistics.snapshot();
        const trialText = `${JSON.stringify(trial, null, 2)}\n`;
        const trialBytes = Buffer.byteLength(trialText);
        if (trialBytes > allowance) throw new Error('Trial record exceeded its reserved metadata allowance.');
        await writeTextAtomic(join(directory, dirname(trial.stdoutPath), 'result.json'), trialText);
        metadata.commit(allowance, trialBytes);
        reservation = 0;
        if (predicateError) throw predicateError;
        await options.onTrialComplete?.(structuredClone(trial));
        if (trial.status === 'interrupted') { stopScheduling = true; controller.abort(); }
        if (trial.status === 'resource_limited' || trial.status === 'output_error') {
          stopScheduling = true;
          delete summary.decision;
          controller.abort();
        }
        if (options.stopWhenDecided !== undefined && !controller.signal.aborted && !summary.metadataLimit) {
          if (trial.terminationReason !== 'exit' || trial.spawningFailed || trial.error
            || (summary.executionRequirement !== undefined && trial.executionMatched !== true)) {
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
      // An unsuccessful persistence attempt may have left partial evidence.
      // Charge its full reservation conservatively, then stop this run.
      if (reservation) metadata.commit(reservation, reservation);
      if (!failed) { failed = true; firstError = error; }
      stopScheduling = true;
      controller.abort();
    }
  };
  try {
    if (declaration !== undefined) {
      summary.context = {
        schemaVersion: 1, workingDirectory: await realpath(cwd), declaration,
        before: await captureContext(cwd, declaration, directory, controller.signal), stable: false,
      };
      await persistHeader();
    }
    // Workers absorb errors so all active trials finish cleanup and durable
    // persistence before the terminal summary (or caller rejection) is exposed.
    await Promise.all(Array.from({ length: Math.min(summary.concurrency!, summary.requestedTrials) }, worker));
    if (failed) throw firstError;
    summary.status = options.signal?.aborted ? 'interrupted'
      : summary.trials.some((trial) => trial.status === 'output_error') ? 'error'
      : summary.metadataLimit ? 'resource_limited'
      : summary.trials.some((trial) => trial.status === 'resource_limited') ? 'resource_limited'
      : summary.trials.some((trial) => trial.status === 'interrupted')
      ? 'interrupted'
      : 'completed';
    if (summary.status === 'error') summary.error = 'Command output could not be fully persisted; inspect trial errors.';
  } catch (error) {
    summary.status = 'error';
    delete summary.decision;
    summary.error = diagnosticMessage(error);
    throw new Error(`Run failed: ${summary.error}\nArtifacts: ${directory}`, { cause: error });
  } finally {
    summary.trials.sort((a, b) => a.index - b.index);
    summary.statistics = aggregateStatistics(summary.trials);
    if (summary.context && !controller.signal.aborted) {
      summary.context.after = await captureContext(cwd, summary.context.declaration, directory, controller.signal);
      summary.context.stable = summary.context.before.issues.length === 0 && summary.context.after.issues.length === 0
        && snapshotsEqual(summary.context.before, summary.context.after);
    }
    if (options.signal?.aborted && summary.status !== 'error') summary.status = 'interrupted';
    options.signal?.removeEventListener('abort', interrupt);
    summary.endedAt = new Date().toISOString();
    await persistHeader();
  }
  return summary;
}

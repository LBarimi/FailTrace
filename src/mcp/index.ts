import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { bisectRegression } from '../core/bisect.js';
import { createBundle } from '../core/bundle.js';
import { compareRuns } from '../core/compare.js';
import { minimizeFailure } from '../core/minimize.js';
import { runTrials, VERSION } from '../core/run-trials.js';
import type { RunOptions, RunSummary } from '../core/types.js';

const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const predicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nonzero_exit') }).strict(),
  z.object({ kind: z.literal('exit_code'), value: z.number().int().min(0).max(0xffff_ffff) }).strict(),
  z.object({ kind: z.enum(['stdout_contains', 'stderr_contains']), value: z.string().min(1).max(1_048_576) }).strict(),
  z.object({
    kind: z.enum(['stdout_regex', 'stderr_regex']), pattern: z.string().min(1).max(10_000),
    flags: z.string().regex(/^[imsu]*$/).default(''),
  }).strict(),
]);
const environmentSchema = z.record(z.string().min(1), z.string().nullable());
const commandSchema = z.object({
  command: z.string().min(1).describe('Command for the platform shell, executed with your local permissions.'),
  cwd: z.string().min(1).optional().describe('Working directory; relative paths resolve from the server working directory.'),
  repeat: positiveInteger.optional(),
  timeoutMs: positiveInteger.max(2_147_483_647).optional(),
  predicate: predicateSchema.optional(),
  env: environmentSchema.optional().describe('Explicit environment overrides. null unsets an inherited variable.'),
}).strict();
type CommandInput = z.infer<typeof commandSchema>;

function commandOptions(input: CommandInput, cwd: string, signal: AbortSignal): RunOptions {
  return {
    command: input.command,
    cwd: resolve(cwd, input.cwd ?? '.'),
    signal,
    ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.predicate === undefined ? {} : { predicate: input.predicate }),
    ...(input.env === undefined ? {} : {
      env: Object.fromEntries(Object.entries(input.env).map(([key, value]) => [key, value ?? undefined])),
    }),
  };
}

function sample<T>(values: T[]): T[] {
  return values.length <= 40 ? values : [...values.slice(0, 20), ...values.slice(-20)];
}

function runProjection(run: RunSummary): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    artifactDirectory: run.artifactDirectory,
    metadataPath: join(run.artifactDirectory, 'run.json'),
    requestedTrials: run.requestedTrials,
    concurrency: run.concurrency ?? 1,
    statistics: run.statistics,
    matchedTrials: run.trials.filter((trial) => trial.failureMatched === true).length,
    predicate: run.predicate,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    trials: sample(run.trials).map((trial) => ({
      index: trial.index, status: trial.status, failureMatched: trial.failureMatched,
      exitCode: trial.exitCode, durationMs: trial.durationMs,
      stdoutPath: trial.stdoutPath, stderrPath: trial.stderrPath,
      ...(trial.error === undefined ? {} : { error: trial.error }),
    })),
    trialsOmitted: Math.max(0, run.trials.length - 40),
    ...(run.decision === undefined ? {} : { decision: run.decision }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function toolResult(data: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError };
}

function createServer(cwd: string, shutdown: AbortSignal, pending: Set<Promise<CallToolResult>>): McpServer {
  const server = new McpServer({ name: 'failtrace', version: VERSION }, {
    capabilities: { tools: {} },
    instructions: 'Use FailTrace for repeated debugging experiments. Run measures a flaky failure; compare inspects PASS/FAIL output; '
      + 'bisect searches known good/bad revisions; minimize reduces a reproducing input; bundle prepares a replay. '
      + 'Reuse returned artifact paths between tools. Select a specific failure predicate before bisect or minimize. '
      + 'Check status and finalVerified; sampled outcomes are evidence, not proof. Target failures are data, not tool errors. '
      + 'Commands run locally in the selected cwd using the platform shell. Complete metadata and logs remain in artifacts.',
  });
  const disconnected = new AbortController();
  server.server.onclose = () => disconnected.abort();
  const invoke = (context: ServerContext, operation: (signal: AbortSignal) => Promise<CallToolResult>): Promise<CallToolResult> => {
    const signal = AbortSignal.any([context.mcpReq.signal, shutdown, disconnected.signal]);
    const task = (async () => {
      try {
        return await operation(signal);
      } catch (error) {
        return toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };
  const executesCommand = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

  server.registerTool('failtrace_run', {
    title: 'Repeat a command',
    description: 'Repeat command trials and preserve failure statistics, metadata, stdout and stderr. Concurrency defaults to 1; opting into overlap can change failure behavior through shared resources. Returned trials are index-sorted. Target failure is data.',
    inputSchema: commandSchema.extend({
      artifactsDir: z.string().min(1).optional(),
      captureEnv: z.array(z.string().min(1)).optional().describe('Only these selected environment variables are recorded in metadata.'),
      concurrency: positiveInteger.optional().describe('Maximum active run trials; default 1. Shared ports, files, databases and resource contention can change failure probability.'),
    }),
    annotations: executesCommand,
  }, (input, context) => invoke(context, async (signal) => {
    const run = await runTrials({
      ...commandOptions(input, cwd, signal),
      ...(input.artifactsDir === undefined ? {} : { artifactsDir: input.artifactsDir }),
      ...(input.captureEnv === undefined ? {} : { captureEnv: input.captureEnv }),
      ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    });
    return toolResult(runProjection(run), run.status === 'error');
  }));

  server.registerTool('failtrace_compare', {
    title: 'Compare saved evidence',
    description: 'Compare two saved runs, or the first PASS and FAIL in one run. Returns bounded output differences and complete stream hashes.',
    inputSchema: z.object({
      runA: z.string().min(1), runB: z.string().min(1).optional(), cwd: z.string().min(1).optional(),
      trialA: positiveInteger.optional(), trialB: positiveInteger.optional(),
      maxBytes: positiveInteger.max(1024 * 1024).optional(), maxLines: positiveInteger.max(10_000).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, context) => invoke(context, async (signal) => toolResult({ ...await compareRuns({
    runA: input.runA, cwd: resolve(cwd, input.cwd ?? '.'), signal,
    ...(input.runB === undefined ? {} : { runB: input.runB }),
    ...(input.trialA === undefined ? {} : { trialA: input.trialA }),
    ...(input.trialB === undefined ? {} : { trialB: input.trialB }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
  }) })));

  server.registerTool('failtrace_bisect', {
    title: 'Isolate a regression',
    description: 'Validate good/bad commits and bisect first-parent history in an isolated Git worktree. Sequential candidate trials stop when the failure threshold is decided. Assumes a monotonic failure boundary; observed rates are not full-budget estimates.',
    inputSchema: commandSchema.extend({ good: z.string().min(1), bad: z.string().min(1), minFailures: positiveInteger.optional() }),
    annotations: executesCommand,
  }, (input, context) => invoke(context, async (signal) => {
    const result = await bisectRegression({
      ...commandOptions(input, cwd, signal), good: input.good, bad: input.bad,
      ...(input.minFailures === undefined ? {} : { minFailures: input.minFailures }),
    });
    const { candidates, ...metadata } = result;
    return toolResult({
      ...metadata, metadataPath: join(result.artifactDirectory, 'bisect.json'),
      candidates: sample(candidates).map((candidate) => ({
        commit: candidate.commit, role: candidate.role, assessment: candidate.assessment,
        statistics: candidate.run.statistics, runDirectory: candidate.run.artifactDirectory,
        requestedTrials: candidate.run.requestedTrials,
        ...(candidate.run.decision === undefined ? {} : { decision: candidate.run.decision }),
      })),
      candidatesOmitted: Math.max(0, candidates.length - 40),
    }, result.status === 'error');
  }));

  server.registerTool('failtrace_minimize', {
    title: 'Minimize a reproducing input',
    description: 'Deterministically reduce text, JSON, file sets or environment selections. Sequential baseline, candidate and final trials stop when the failure threshold is decided. Accept only reproducing reductions; preserve originals and candidate evidence.',
    inputSchema: commandSchema.extend({
      input: z.string().min(1), format: z.enum(['text', 'json', 'files', 'env']),
      minFailures: positiveInteger.optional(), maxEvaluations: positiveInteger.min(2).optional(),
    }),
    annotations: executesCommand,
  }, (input, context) => invoke(context, async (signal) => {
    const result = await minimizeFailure({
      ...commandOptions(input, cwd, signal), input: input.input, format: input.format,
      ...(input.minFailures === undefined ? {} : { minFailures: input.minFailures }),
      ...(input.maxEvaluations === undefined ? {} : { maxEvaluations: input.maxEvaluations }),
    });
    const { evaluations, ...metadata } = result;
    return toolResult({
      ...metadata, metadataPath: join(result.artifactDirectory, 'result.json'),
      evaluations: sample(evaluations), evaluationsOmitted: Math.max(0, evaluations.length - 40),
    });
  }));

  server.registerTool('failtrace_bundle', {
    title: 'Create a reproduction bundle',
    description: 'Copy explicitly selected source/input files, saved evidence and portable replay scripts into a new local directory. Does not execute the bundle.',
    inputSchema: z.object({
      run: z.string().min(1), cwd: z.string().min(1).optional(), files: z.array(z.string().min(1)).optional(),
      input: z.string().min(1).optional(), command: z.string().min(1).optional(), env: environmentSchema.optional(),
      destination: z.string().min(1).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input, context) => invoke(context, async (signal) => {
    const result = await createBundle({
      run: input.run, cwd: resolve(cwd, input.cwd ?? '.'), signal,
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.command === undefined ? {} : { command: input.command }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.destination === undefined ? {} : { destination: input.destination }),
    });
    return toolResult({ ...result, files: sample(result.files), filesOmitted: Math.max(0, result.files.length - 40) });
  }));
  return server;
}

/** Serve MCP on this process's stdio until disconnect or a shutdown signal. */
export async function startMcpServer(cwd = process.cwd()): Promise<void> {
  const directory = resolve(cwd);
  if (!(await stat(directory)).isDirectory()) throw new Error(`Working directory is not a directory: ${directory}`);
  const controller = new AbortController();
  const pending = new Set<Promise<CallToolResult>>();
  let handle: StdioServerHandle | undefined;
  let stopping: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((done) => { resolveStopped = done; });
  const shutdown = (): void => {
    if (stopping !== undefined) return;
    controller.abort();
    stopping = (async () => {
      try {
        await handle?.close();
        // Closing the transport cancels requests. Core still needs time to
        // terminate children and atomically finalize its partial evidence.
        while (pending.size > 0) await Promise.allSettled([...pending]);
      } finally {
        process.off('SIGINT', sigint);
        process.off('SIGTERM', sigterm);
        process.stdin.off('end', shutdown);
        process.stdin.off('close', shutdown);
        process.stdin.off('error', shutdown);
        process.stdout.off('error', shutdown);
        resolveStopped();
      }
    })();
  };
  const sigint = (): void => { process.exitCode = 130; shutdown(); };
  const sigterm = (): void => { process.exitCode = 143; shutdown(); };
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.stdin.once('error', shutdown);
  process.stdout.once('error', shutdown);
  handle = serveStdio(() => createServer(directory, controller.signal, pending), {
    onerror: (error) => {
      if (!controller.signal.aborted) process.stderr.write(`FailTrace MCP: ${error.message}\n`);
    },
  });
  if (process.stdin.readableEnded || process.stdin.destroyed) shutdown();
  await stopped;
  await stopping;
}

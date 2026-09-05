import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { terminateProcessTree } from './process-tree.js';
import { effectiveEnvironment } from './environment.js';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_TOTAL_OUTPUT_BYTES, OutputBudget, type OutputLimit } from './output-budget.js';
import type { TrialOptions, TrialResult } from './types.js';

interface ExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: 'timeout' | 'interrupted' | 'output_limit' | 'output_error';
  spawnError?: string;
  cleanupError?: string;
  outputLimit?: OutputLimit;
  outputError?: string;
}

function commandEnvironment(options: TrialOptions): NodeJS.ProcessEnv {
  return effectiveEnvironment({
    ...options.env,
    FAILTRACE_TRIAL_INDEX: String(options.index),
  });
}

async function execute(
  options: TrialOptions,
  stdout: FileHandle,
  stderr: FileHandle,
): Promise<ExecutionResult> {
  if (options.signal?.aborted) {
    return { exitCode: null, signal: null, stopReason: 'interrupted' };
  }

  let child: ChildProcess;
  try {
    // Passing the entire command, without an argument array, preserves the
    // platform shell's syntax (cmd.exe /d /s /c on Windows; /bin/sh on POSIX).
    child = spawn(options.command, {
      cwd: options.cwd,
      env: commandEnvironment(options),
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }

  let stopReason: ExecutionResult['stopReason'];
  let spawnError: string | undefined;
  let cleanup: Promise<string | undefined> | undefined;
  let completed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let outputLimit: OutputLimit | undefined;
  let outputError: string | undefined;
  let retained = 0;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const budget = options.outputBudget ?? new OutputBudget(DEFAULT_MAX_TOTAL_OUTPUT_BYTES);
  let resolveCompletion!: (result: ExecutionResult) => void;
  const completion = new Promise<ExecutionResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const complete = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (completed) return;
    completed = true;
    resolveCompletion({
      exitCode,
      signal,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(spawnError === undefined ? {} : { spawnError }),
    });
  };

  const stop = (reason: NonNullable<ExecutionResult['stopReason']>): void => {
    if (completed || stopReason !== undefined) return;
    stopReason = reason;
    clearTimeout(timeout);
    cleanup = terminateProcessTree(child);
    void cleanup.then(() => {
      // Do not let an unkillable child keep either this promise or Node alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      complete(child.exitCode, child.signalCode);
    });
  };
  const interrupt = (): void => stop('interrupted');

  child.once('close', complete);
  child.on('error', (error: Error) => {
    spawnError = error.message;
    complete(null, null);
  });
  timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
  options.signal?.addEventListener('abort', interrupt, { once: true });
  // Covers an abort between the pre-spawn check and listener registration.
  if (options.signal?.aborted) interrupt();

  const capture = async (stream: Readable, file: FileHandle): Promise<void> => {
    try {
      for await (const value of stream) {
        const chunk = value as Buffer;
        // Reserve both streams' bytes before awaiting disk I/O. Backpressure
        // bounds memory and the shared budget bounds concurrent candidate output.
        const withinTrial = Math.min(chunk.length, Math.max(0, maxOutputBytes - retained));
        const accepted = budget.take(withinTrial);
        retained += accepted;
        let offset = 0;
        while (offset < accepted) {
          const { bytesWritten } = await file.write(chunk, offset, accepted - offset);
          if (bytesWritten === 0) throw new Error('Output write made no progress.');
          offset += bytesWritten;
        }
        if (accepted < chunk.length) {
          outputLimit ??= accepted < withinTrial
            ? { scope: 'experiment', limitBytes: budget.limitBytes }
            : { scope: 'trial', limitBytes: maxOutputBytes };
          stop('output_limit');
          // Drain until bounded process cleanup closes the pipes, without
          // retaining any more bytes. Do not let a full pipe stall termination.
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (stopReason && (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ABORT_ERR')) return;
      outputError ??= error instanceof Error ? error.message : String(error);
      stop('output_error');
    }
  };
  const captures = [capture(child.stdout!, stdout), capture(child.stderr!, stderr)];

  try {
    const result = await completion;
    // Wait for descendant cleanup even if the shell closes before its children.
    const cleanupError = await cleanup;
    await Promise.all(captures);
    return { ...result,
      ...(outputLimit === undefined ? {} : { outputLimit, stopReason: 'output_limit' }),
      ...(outputError === undefined ? {} : { outputError, stopReason: 'output_error' }),
      ...(cleanupError === undefined ? {} : { cleanupError }),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', interrupt);
  }
}

/** Execute one command, streaming bounded evidence into exclusive artifact files. */
export async function runTrial(options: TrialOptions): Promise<TrialResult> {
  const relativeDirectory = `trials/${String(options.index).padStart(3, '0')}`;
  const directory = join(options.runDirectory, relativeDirectory);
  await mkdir(join(options.runDirectory, 'trials'), { recursive: true });
  // Refuse to reuse a trial directory or truncate existing evidence.
  await mkdir(directory);
  const stdoutPath = `${relativeDirectory}/stdout.txt`;
  const stderrPath = `${relativeDirectory}/stderr.txt`;
  const stdout = await open(join(options.runDirectory, stdoutPath), 'wx');
  let stderr: FileHandle | undefined;
  try {
    stderr = await open(join(options.runDirectory, stderrPath), 'wx');
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const execution = await execute(options, stdout, stderr);
    const timedOut = execution.stopReason === 'timeout';
    const spawningFailed = execution.spawnError !== undefined;
    const interrupted = execution.stopReason === 'interrupted';
    const error = execution.outputError ?? execution.spawnError ?? execution.cleanupError;
    const status = execution.outputError !== undefined ? 'output_error'
      : execution.outputLimit ? 'resource_limited'
      : interrupted ? 'interrupted'
      : timedOut ? 'timed_out'
        : spawningFailed ? 'spawn_error'
          : execution.exitCode === 0 ? 'passed' : 'failed';
    const terminationReason = execution.outputError !== undefined ? 'output_error'
      : execution.outputLimit ? 'output_limit'
      : interrupted ? 'interrupted'
      : timedOut ? 'timeout'
        : spawningFailed ? 'spawn_error'
          : execution.signal !== null ? 'signal' : 'exit';

    return {
      index: options.index,
      command: options.command,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      exitCode: execution.exitCode,
      signal: execution.signal,
      status,
      timedOut,
      spawningFailed,
      terminationReason,
      ...(error === undefined ? {} : { error }),
      ...(execution.outputLimit === undefined ? {} : { outputLimit: execution.outputLimit }),
      stdoutPath,
      stderrPath,
    };
  } finally {
    await Promise.all([stdout.close(), stderr?.close()]);
  }
}

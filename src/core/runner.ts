import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { terminateProcessTree } from './process-tree.js';
import type { TrialOptions, TrialResult } from './types.js';

interface ExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: 'timeout' | 'interrupted';
  spawnError?: string;
  cleanupError?: string;
}

function commandEnvironment(options: TrialOptions): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const overrides = {
    ...options.env,
    FAILTRACE_TRIAL_INDEX: String(options.index),
  };
  for (const [key, value] of Object.entries(overrides)) {
    // Windows environment keys are case-insensitive. Avoid duplicate PATH/Path
    // entries, whose ordering would otherwise decide which value Node uses.
    if (process.platform === 'win32') {
      for (const inherited of Object.keys(environment)) {
        if (inherited.toLowerCase() === key.toLowerCase()) delete environment[inherited];
      }
    }
    environment[key] = value;
  }
  return environment;
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
      stdio: ['ignore', stdout.fd, stderr.fd],
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

  const stop = (reason: 'timeout' | 'interrupted'): void => {
    if (completed || stopReason !== undefined) return;
    stopReason = reason;
    clearTimeout(timeout);
    cleanup = terminateProcessTree(child);
    void cleanup.then(() => {
      // Do not let an unkillable child keep either this promise or Node alive.
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

  try {
    const result = await completion;
    // Wait for descendant cleanup even if the shell closes before its children.
    const cleanupError = await cleanup;
    return cleanupError === undefined ? result : { ...result, cleanupError };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', interrupt);
  }
}

/** Execute one command, streaming evidence directly into exclusive artifact files. */
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
    const error = execution.spawnError ?? execution.cleanupError;
    const status = interrupted ? 'interrupted'
      : timedOut ? 'timed_out'
        : spawningFailed ? 'spawn_error'
          : execution.exitCode === 0 ? 'passed' : 'failed';
    const terminationReason = interrupted ? 'interrupted'
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
      stdoutPath,
      stderrPath,
    };
  } finally {
    await Promise.all([stdout.close(), stderr?.close()]);
  }
}

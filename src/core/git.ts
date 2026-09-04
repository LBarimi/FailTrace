import { spawn } from 'node:child_process';
import { terminateProcessTree } from './process-tree.js';

export interface GitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Preserve ordinary environment while pinning Git operations to local, real objects. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A Git hook or calling shell may export these. They must not redirect an
  // isolated worktree operation to the caller's index or working directory.
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|TERMINAL_PROMPT|NO_LAZY_FETCH|NO_REPLACE_OBJECTS)$/i.test(key)) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

/** Run local Git with literal arguments, bounded output, and bounded cancellation. */
export async function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw new Error('Git operation interrupted.');
  const child = spawn('git', args, {
    cwd,
    env: gitEnvironment(),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const limit = 8 * 1024 * 1024;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failure: string | undefined;
  let cleanup: Promise<string | undefined> | undefined;
  let complete!: (code: number | null) => void;
  const completion = new Promise<number | null>((resolve) => { complete = resolve; });
  let exited = false;
  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    complete(code);
  };
  const stop = (reason: string): void => {
    if (exited || cleanup !== undefined) return;
    failure = reason;
    cleanup = terminateProcessTree(child);
    void cleanup.then(() => {
      child.unref();
      finish(child.exitCode);
    });
  };
  const capture = (chunks: Buffer[]) => (chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes > limit) stop('Git output exceeded the 8 MiB limit.');
    else chunks.push(chunk);
  };
  child.stdout.on('data', capture(stdout));
  child.stderr.on('data', capture(stderr));
  child.on('error', (error) => {
    failure = `Unable to run Git: ${error.message}`;
    finish(null);
  });
  child.once('close', finish);
  const timer = setTimeout(() => stop('Git operation timed out.'), options.timeoutMs ?? 30_000);
  const interrupt = (): void => stop('Git operation interrupted.');
  options.signal?.addEventListener('abort', interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  try {
    const code = await completion;
    const cleanupError = await cleanup;
    if (failure !== undefined) throw new Error(`${failure}${cleanupError ? ` ${cleanupError}` : ''}`);
    if (code !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      throw new Error(`Git ${args[0] ?? ''} failed (exit ${String(code)}): ${detail}`);
    }
    return Buffer.concat(stdout).toString('utf8').trimEnd();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', interrupt);
    // A stuck Git hook can inherit these pipes. They must not keep Node alive
    // after the bounded process-tree cleanup has completed.
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

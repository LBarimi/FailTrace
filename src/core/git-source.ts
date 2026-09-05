import { spawn } from 'node:child_process';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, win32 } from 'node:path';
import { gitEnvironment } from './git.js';
import { terminateProcessTree } from './process-tree.js';
import type { RunSummary } from './types.js';

type GitSource = NonNullable<RunSummary['source']>;

function sourcePath(source: GitSource, file: string): string {
  if (source.kind !== 'git' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(source.commit)) {
    throw new Error('Git source must identify an immutable commit hash.');
  }
  if (typeof source.repository !== 'string' || !isAbsolute(source.repository) || source.repository.includes('\0')) {
    throw new Error('Git source must identify an absolute local repository path.');
  }
  const parts: string[] = [];
  for (const value of [source.subdirectory, file]) {
    if (typeof value !== 'string' || isAbsolute(value) || win32.isAbsolute(value) || value.includes('\0')) {
      throw new Error('Git source paths must be relative to the recorded repository.');
    }
    for (const part of value.replaceAll('\\', '/').split('/')) {
      if (part === '..') throw new Error('Git source paths cannot escape the recorded subdirectory.');
      if (part !== '' && part !== '.') parts.push(part);
    }
  }
  if (file === '' || parts.length === 0) throw new Error('Select a Git source file.');
  return parts.join('/');
}

/** Metadata is bounded; blob bytes go straight to the supplied descriptor. */
async function readGit(source: GitSource, args: string[], signal?: AbortSignal, output?: number): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn('git', ['--no-replace-objects', '--literal-pathspecs', ...args], {
    cwd: source.repository,
    env: gitEnvironment(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', output ?? 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failure: string | undefined;
  let cleanup: Promise<string | undefined> | undefined;
  let completed = false;
  let resolveCompletion!: (code: number | null) => void;
  const completion = new Promise<number | null>((done) => { resolveCompletion = done; });
  const finish = (code: number | null): void => {
    if (completed) return;
    completed = true;
    resolveCompletion(code);
  };
  const stop = (reason: string): void => {
    if (completed || cleanup !== undefined) return;
    failure = reason;
    cleanup = terminateProcessTree(child);
    void cleanup.then(() => {
      child.unref();
      finish(child.exitCode);
    });
  };
  const capture = (chunks: Buffer[]) => (chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes > 128 * 1024) stop('Git source metadata exceeded the 128 KiB limit.');
    else chunks.push(chunk);
  };
  child.stdout?.on('data', capture(stdout));
  child.stderr?.on('data', capture(stderr));
  child.on('error', (error) => { failure = `Unable to read Git source: ${error.message}`; finish(null); });
  child.once('close', finish);
  const timer = setTimeout(() => stop('Git source export timed out.'), 30_000);
  const interrupt = (): void => stop('Git source export interrupted.');
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  try {
    const code = await completion;
    const cleanupError = await cleanup;
    if (failure !== undefined) throw new Error(`${failure}${cleanupError ? ` ${cleanupError}` : ''}`);
    if (code !== 0) throw new Error(`Git source export failed (exit ${String(code)}): ${Buffer.concat(stderr).toString('utf8').trim()}`);
    return Buffer.concat(stdout).toString('utf8');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', interrupt);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

/** Copy one regular file from a recorded local commit without a checkout or fetch. */
export async function copyGitSourceFile(source: GitSource, file: string, destination: string, signal?: AbortSignal, reserve?: (bytes: number) => void): Promise<void> {
  const path = sourcePath(source, file);
  const listing = await readGit(source, ['ls-tree', '--full-tree', '-z', source.commit, '--', path], signal);
  const entries = listing.split('\0').filter(Boolean);
  const entry = entries.length === 1 ? entries[0] : undefined;
  const match = entry?.match(/^(100644|100755) blob ([a-f\d]{40}|[a-f\d]{64})\t([\s\S]+)$/i);
  if (match === undefined || match === null || match[3] !== path) {
    throw new Error(`Selected Git source must be a committed regular file; links, submodules, directories and missing files are unsupported: ${file}`);
  }
  const blob = match[2]!;
  const sizeText = (await readGit(source, ['cat-file', '-s', blob], signal)).trim();
  const bytes = Number(sizeText);
  if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(bytes)) throw new Error('Invalid Git source size.');
  reserve?.(bytes);
  signal?.throwIfAborted();
  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, 'wx');
  try {
    await readGit(source, ['cat-file', 'blob', blob], signal, handle.fd);
    if ((await handle.stat()).size !== bytes) throw new Error('Git source export size does not match its immutable blob.');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (match[1] === '100755') await chmod(destination, 0o755);
}

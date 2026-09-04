import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const fixturePath = fileURLToPath(new URL('./fixtures/command.mjs', import.meta.url));
export const cliPath = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

export function quoteShellArgument(value: string): string {
  return process.platform === 'win32'
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function fixtureCommand(mode: string, ...args: string[]): string {
  return [process.execPath, fixturePath, mode, ...args].map(quoteShellArgument).join(' ');
}

export async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'failtrace tests '));
}

export async function cleanupDirectories(directories: string[]): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 100,
  })));
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await readFile(path, 'utf8');
      if (value.length > 0) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error(`Fixture did not create ${path} within ${timeoutMs} ms`);
}

export async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(20);
  }
  throw new Error(`Descendant process ${pid} survived trial cleanup`);
}

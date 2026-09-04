import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunSummary } from '../src/core/types.js';
import { cleanupDirectories, cliPath, quoteShellArgument, temporaryDirectory, waitForFile, waitForProcessExit } from './helpers.js';

const execute = promisify(execFile);
const clients: Client[] = [];
const directories: string[] = [];
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const node = quoteShellArgument(process.execPath);

async function startClient(modern = false): Promise<{
  client: Client; transport: StdioClientTransport; cwd: string; errors: Error[]; stderr: string[];
}> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  const client = new Client({ name: 'failtrace-integration-tests', version: '1.0.0' }, modern
    ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  clients.push(client);
  const errors: Error[] = [];
  const stderr: string[] = [];
  client.onerror = (error) => errors.push(error);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp', '--cwd', cwd], cwd, stderr: 'pipe' });
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  await client.connect(transport);
  return { client, transport, cwd, errors, stderr };
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', args, { cwd, windowsHide: true, timeout: 10_000 });
  return stdout.trim();
}

async function completedRun(cwd: string): Promise<RunSummary> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const ids = await readdir(join(cwd, '.failtrace', 'runs'));
      for (const id of ids) {
        const result = JSON.parse(await readFile(join(cwd, '.failtrace', 'runs', id, 'run.json'), 'utf8')) as RunSummary;
        if (result.endedAt !== null) return result;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('MCP operation did not finalize its run evidence.');
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await cleanupDirectories(directories);
});

describe('official SDK stdio MCP adapter', () => {
  it('lists typed tools and invokes all five Core workflows over a real SDK connection', async () => {
    const { client, cwd, errors, stderr } = await startClient();
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name).sort()).toEqual([
      'failtrace_bisect', 'failtrace_bundle', 'failtrace_compare', 'failtrace_minimize', 'failtrace_run',
    ]);
    for (const tool of listing.tools) expect(tool.inputSchema.type).toBe('object');
    for (const name of ['failtrace_run', 'failtrace_bisect', 'failtrace_minimize']) {
      expect(listing.tools.find((tool) => tool.name === name)!.annotations?.destructiveHint).toBe(true);
    }
    expect(listing.tools.find((tool) => tool.name === 'failtrace_compare')!.annotations?.readOnlyHint).toBe(true);

    await copyFile(join(fixtures, 'bundle-target.mjs'), join(cwd, 'target.mjs'));
    const runCall = await client.callTool({ name: 'failtrace_run', arguments: { command: `${node} target.mjs mixed`, repeat: 2 } });
    expect(runCall.isError).toBe(false);
    const run = structured(runCall);
    expect(run.status).toBe('completed');
    expect(run.statistics).toMatchObject({ total: 2, passed: 1, failed: 1, failureRate: 0.5 });
    const runDirectory = run.artifactDirectory as string;
    expect(await readFile(join(runDirectory, 'trials', '002', 'stderr.txt'), 'utf8')).toContain('EXPECTED_BUNDLE_FAILURE');

    const comparison = await client.callTool({ name: 'failtrace_compare', arguments: { runA: runDirectory } });
    expect(comparison.isError).toBe(false);
    expect(structured(comparison)).toMatchObject({ trialA: 1, trialB: 2, stderr: { equal: false } });

    const bundled = await client.callTool({
      name: 'failtrace_bundle', arguments: { run: runDirectory, files: ['target.mjs'], command: 'node target.mjs mixed' },
    });
    expect(bundled.isError).toBe(false);
    const bundle = structured(bundled);
    expect(JSON.parse(await readFile(bundle.configPath as string, 'utf8')).command).toBe('node target.mjs mixed');
    expect(await readFile(join(bundle.directory as string, 'source', 'target.mjs'), 'utf8'))
      .toBe(await readFile(join(cwd, 'target.mjs'), 'utf8'));

    await copyFile(join(fixtures, 'minimize-command.mjs'), join(cwd, 'minimize.mjs'));
    await writeFile(join(cwd, 'input.txt'), 'xBUGy');
    const minimized = await client.callTool({
      name: 'failtrace_minimize', arguments: { command: `${node} minimize.mjs`, input: 'input.txt', format: 'text', maxEvaluations: 40 },
    }, { timeout: 30_000 });
    expect(minimized.isError).toBe(false);
    expect(structured(minimized)).toMatchObject({ status: 'completed', finalVerified: true, originalSize: 5, minimizedSize: 3 });
    expect(await readFile(structured(minimized).minimizedPath as string, 'utf8')).toBe('BUG');
    expect(await readFile(join(cwd, 'input.txt'), 'utf8')).toBe('xBUGy');

    const repository = join(cwd, 'repository');
    await mkdir(repository);
    await git(repository, 'init', '-b', 'main');
    await git(repository, 'config', 'user.name', 'FailTrace MCP Test');
    await git(repository, 'config', 'user.email', 'mcp@example.invalid');
    await writeFile(join(repository, '.gitignore'), '.failtrace/\n');
    await writeFile(join(repository, 'target.mjs'), 'process.exitCode = 0;\n');
    await git(repository, 'add', '.');
    await git(repository, '-c', 'commit.gpgsign=false', 'commit', '-m', 'good');
    const good = await git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'target.mjs'), 'process.exitCode = 7;\n');
    await git(repository, 'add', '.');
    await git(repository, '-c', 'commit.gpgsign=false', 'commit', '-m', 'bad');
    const bad = await git(repository, 'rev-parse', 'HEAD');
    const bisected = await client.callTool({
      name: 'failtrace_bisect', arguments: { command: `${node} target.mjs`, cwd: 'repository', good, bad, repeat: 2 },
    }, { timeout: 30_000 });
    expect(bisected.isError).toBe(false);
    expect(structured(bisected)).toMatchObject({ status: 'found', firstBad: bad, lastGood: good });
    expect(errors).toEqual([]);
    // Target stdout/stderr belong to evidence files, never MCP stdout or server diagnostics.
    expect(stderr.join('')).toBe('');
  }, 30_000);

  it('supports the modern protocol with the same typed tools', async () => {
    const { client, errors, stderr } = await startClient(true);
    expect((await client.listTools()).tools).toHaveLength(5);
    const call = await client.callTool({
      name: 'failtrace_run', arguments: { command: process.platform === 'win32' ? 'exit /b 7' : 'exit 7', repeat: 1 },
    });
    expect(call.isError).toBe(false);
    expect(structured(call).statistics).toMatchObject({ total: 1, failed: 1 });
    expect(errors).toEqual([]);
    expect(stderr.join('')).toBe('');
  });

  it('validates schemas and reports Core errors without terminating the server', async () => {
    const { client } = await startClient();
    await client.listTools();
    const invalidInput = await client.callTool({ name: 'failtrace_run', arguments: { command: 'exit 0', repeat: 0 } });
    expect(invalidInput.isError).toBe(true);
    expect(invalidInput.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('Input validation error') })]);
    const invalidRegex = await client.callTool({
      name: 'failtrace_run', arguments: { command: 'exit 0', predicate: { kind: 'stdout_regex', pattern: '[' } },
    });
    expect(invalidRegex.isError).toBe(true);
    expect(structured(invalidRegex).error).toMatch(/Invalid failure regex/);
    const missing = await client.callTool({ name: 'failtrace_compare', arguments: { runA: 'missing-run' } });
    expect(missing.isError).toBe(true);
    expect(structured(missing).error).toBeTypeOf('string');
    expect((await client.listTools()).tools).toHaveLength(5);
  });

  it('maps null environment values to unset and captures selected environment evidence', async () => {
    const { client, cwd } = await startClient();
    await copyFile(join(fixtures, 'command.mjs'), join(cwd, 'environment.mjs'));
    const call = await client.callTool({
      name: 'failtrace_run', arguments: {
        command: `${node} environment.mjs environment`, repeat: 1,
        env: { FAILTRACE_TEST_VALUE: null }, captureEnv: ['FAILTRACE_TEST_VALUE'],
      },
    });
    expect(call.isError).toBe(false);
    const metadata = JSON.parse(await readFile(structured(call).metadataPath as string, 'utf8')) as RunSummary;
    expect(metadata.environment?.variables.FAILTRACE_TEST_VALUE).toBeNull();
    expect(await readFile(join(metadata.artifactDirectory, metadata.trials[0]!.stdoutPath), 'utf8')).toContain('undefined');
  });

  it('bounds returned trial details while preserving the complete run on disk', async () => {
    const { client } = await startClient();
    const call = await client.callTool({
      name: 'failtrace_run', arguments: { command: process.platform === 'win32' ? 'exit /b 0' : 'exit 0', repeat: 45 },
    }, { timeout: 30_000 });
    const data = structured(call);
    expect(data.trialsOmitted).toBe(5);
    expect(data.trials).toHaveLength(40);
    expect((data.trials as Array<{ index: number }>).map((trial) => trial.index)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index + 1), ...Array.from({ length: 20 }, (_, index) => index + 26),
    ]);
    expect(JSON.parse(await readFile(data.metadataPath as string, 'utf8')).trials).toHaveLength(45);
  }, 30_000);

  it('propagates request cancellation to Core and preserves valid partial results', async () => {
    const { client, cwd } = await startClient();
    await copyFile(join(fixtures, 'command.mjs'), join(cwd, 'hang.mjs'));
    const marker = join(cwd, 'child.pid');
    const controller = new AbortController();
    const outcome = client.callTool({
      name: 'failtrace_run', arguments: { command: `${node} hang.mjs hang ${quoteShellArgument(marker)}`, repeat: 5, timeoutMs: 10_000 },
    }, { signal: controller.signal, timeout: 20_000 }).then((value) => ({ value }), (error: unknown) => ({ error }));
    const pid = Number(await waitForFile(marker));
    controller.abort();
    expect(await outcome).toHaveProperty('error');
    const run = await completedRun(cwd);
    expect(run.status).toBe('interrupted');
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]!.status).toBe('interrupted');
    await waitForProcessExit(pid);
  });

  it('aborts active commands and finishes metadata when the SDK client disconnects', async () => {
    const { client, transport, cwd } = await startClient();
    await copyFile(join(fixtures, 'command.mjs'), join(cwd, 'hang.mjs'));
    const marker = join(cwd, 'child.pid');
    const serverPid = transport.pid!;
    const outcome = client.callTool({
      name: 'failtrace_run', arguments: { command: `${node} hang.mjs hang ${quoteShellArgument(marker)}`, repeat: 5, timeoutMs: 10_000 },
    }, { timeout: 20_000 }).then((value) => ({ value }), (error: unknown) => ({ error }));
    const childPid = Number(await waitForFile(marker));
    await client.close();
    expect(await outcome).toHaveProperty('error');
    const run = await completedRun(cwd);
    expect(run.status).toBe('interrupted');
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]!.status).toBe('interrupted');
    await waitForProcessExit(childPid);
    await waitForProcessExit(serverPid);
  });
});

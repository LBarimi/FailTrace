import { spawn } from 'node:child_process';
import { copyFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { createBundle, runTrials } from '../src/core/index.js';
import { cleanupDirectories, cliPath, quoteShellArgument, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
const clients: Client[] = [];
const fixture = fileURLToPath(new URL('./fixtures/output.mjs', import.meta.url));
const command = [process.execPath, fixture, 'target', '64'].map(quoteShellArgument).join(' ');
async function workspace(): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  return cwd;
}
async function invoke(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await cleanupDirectories(directories);
});

describe('output caps through public adapters', () => {
  it.each([
    ['run', 'node target.mjs'],
    ['bisect', '--command', 'node target.mjs', '--good', 'good', '--bad', 'bad'],
    ['minimize', '--command', 'node target.mjs', '--input', 'input.txt'],
    ['verify', 'baseline', '--command', 'node target.mjs', '--cwd', '.'],
  ])('parses explicit byte caps for %s', (...args) => {
    expect(parseArgs([...args, '--max-output-bytes', '32', '--max-total-output-bytes', '64']))
      .toMatchObject({ maxOutputBytes: 32, maxTotalOutputBytes: 64 });
    expect(() => parseArgs([...args, '--max-output-bytes', '0'])).toThrow();
  });

  it('emits an inconclusive JSON result with CLI exit 2 and explains the limit in terminal output', async () => {
    const cwd = await workspace();
    const args = [cliPath, 'run', command, '--repeat', '1', '--max-output-bytes', '32'];
    const json = await invoke([...args, '--json'], cwd);
    expect(json.code).toBe(2);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout)).toMatchObject({ status: 'resource_limited', maxOutputBytes: 32,
      trials: [{ terminationReason: 'output_limit', failureMatched: false }] });
    const terminal = await invoke(args, cwd);
    expect(terminal.code).toBe(2);
    expect(terminal.stdout).toContain('Run inconclusive: output limit reached');
    expect(terminal.stdout).not.toContain('No failure reproduced');
  });

  it('exposes shared caps and incomplete evidence through MCP run and saved inspection', async () => {
    const cwd = await workspace();
    const client = new Client({ name: 'output-limit-test', version: '1.0.0' });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp', '--cwd', cwd], stderr: 'pipe' });
    await client.connect(transport);
    const listing = await client.listTools();
    for (const name of ['failtrace_run', 'failtrace_bisect', 'failtrace_minimize', 'failtrace_verify']) {
      expect(listing.tools.find((tool) => tool.name === name)!.inputSchema.properties).toHaveProperty('maxTotalOutputBytes');
    }
    const result = await client.callTool({ name: 'failtrace_run', arguments: { command, repeat: 1, maxOutputBytes: 64, maxTotalOutputBytes: 32 } });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ status: 'resource_limited', maxTotalOutputBytes: 32, matchedTrials: 0,
      trials: [{ terminationReason: 'output_limit', outputLimit: { scope: 'experiment', limitBytes: 32 } }] });
    const saved = await client.callTool({ name: 'failtrace_inspect_run', arguments: {
      run: (result.structuredContent as Record<string, unknown>).artifactDirectory, view: 'trials', filter: 'unhealthy',
    } });
    expect(saved.isError).toBe(false);
    expect(saved.structuredContent).toMatchObject({ status: 'resource_limited', trials: [{ unhealthy: true, outputLimit: { scope: 'experiment' } }] });
  });

  it('preserves the source run caps in a relocated bundle and returns replay exit 2', async () => {
    const cwd = await workspace();
    await copyFile(fixture, join(cwd, 'output.mjs'));
    const run = await runTrials({ cwd, command: 'node output.mjs target 64', repeat: 1, maxOutputBytes: 32, maxTotalOutputBytes: 48 });
    const bundle = await createBundle({ cwd, run: run.artifactDirectory, files: ['output.mjs'] });
    expect(JSON.parse(await readFile(bundle.configPath, 'utf8'))).toMatchObject({ maxOutputBytes: 32, maxTotalOutputBytes: 48 });
    const relocated = join(cwd, 'relocated bundle');
    await rename(bundle.directory, relocated);
    const result = await invoke([join(relocated, 'repro.mjs')], cwd);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('Replay inconclusive');
    expect(result.stderr).toBe('');
  });
});

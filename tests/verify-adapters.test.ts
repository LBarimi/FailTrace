import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import type { RunSummary, VerifyResult } from '../src/core/index.js';
import { cleanupDirectories, cliPath, quoteShellArgument, temporaryDirectory, waitForFile, waitForProcessExit } from './helpers.js';

const directories: string[] = [];
const clients: Client[] = [];
const command = `${quoteShellArgument(process.execPath)} target.mjs`;
const context = { inputFiles: ['input.json'], setupFiles: ['setup.json'], sourceFiles: ['target.mjs'] };
const predicate = { kind: 'stderr_contains', value: 'VERIFY_TARGET' } as const;
const affected = "import { readFileSync } from 'node:fs';\n"
  + "if (JSON.parse(readFileSync('input.json', 'utf8')).includes('BUG')) { console.error('VERIFY_TARGET'); process.exitCode = 7; }\n";
const fixed = "import { readFileSync } from 'node:fs';\n"
  + "JSON.parse(readFileSync('input.json', 'utf8')); console.log('healthy');\n";
const unrelated = "throw new Error('UNRELATED_FAILURE');\n";

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await cleanupDirectories(directories);
});

async function project(): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  await writeFile(join(cwd, 'target.mjs'), affected);
  await writeFile(join(cwd, 'input.json'), '["BUG"]\n');
  await writeFile(join(cwd, 'setup.json'), '{"fixture":1}\n');
  return cwd;
}

function invoke(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(false);
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

describe('Verify CLI parsing', () => {
  it('captures explicitly selected context without changing ordinary run defaults', () => {
    expect(parseArgs(['run', command])).not.toHaveProperty('captureContext');
    expect(parseArgs(['run', command, '--capture-context'])).toMatchObject({ captureContext: {} });
    expect(parseArgs(['run', command, '--context-input', 'a.json', '--context-input=b.json', '--context-setup', 'lock.json', '--context-source', 'target.mjs']))
      .toMatchObject({ captureContext: { inputFiles: ['a.json', 'b.json'], setupFiles: ['lock.json'], sourceFiles: ['target.mjs'] } });
  });

  it('requires current execution authority and preserves inherited sampling defaults', () => {
    expect(parseArgs(['verify', 'baseline', '--command', command, '--cwd', '.'])).toEqual({ kind: 'verify', baseline: 'baseline', command, cwd: '.' });
    expect(parseArgs(['verify', 'baseline', '--command', command, '--cwd', '.', '--repeat', '5', '--timeout', '2s', '--concurrency', '2', '--allow-change', 'source:repair parser', '--allow-change=setup:update fixture: documented', '--healthy-exit-code', '0', '--healthy-exit-code', '2', '--json']))
      .toEqual({ kind: 'verify', baseline: 'baseline', command, cwd: '.', repeat: 5, timeoutMs: 2000, concurrency: 2, allowChanges: [{ field: 'source', reason: 'repair parser' }, { field: 'setup', reason: 'update fixture: documented' }], healthyExitCodes: [0, 2], json: true });
  });

  it.each([
    ['verify'], ['verify', 'baseline', '--command', command], ['verify', 'baseline', '--cwd', '.'],
    ['verify', 'baseline', '--command', command, '--cwd', '.', '--stderr-contains', 'changed'],
    ['verify', 'baseline', '--command', command, '--cwd', '.', '--allow-change', 'source'],
    ['verify', 'baseline', '--command', command, '--cwd', '.', '--allow-change', 'source:  '],
    ['verify', 'baseline', '--command', command, '--cwd', '.', '--allow-change', 'predicate:changed'],
    ['verify', 'baseline', '--command', command, '--cwd', '.', '--allow-change', 'source:one', '--allow-change', 'source:two'],
    ['verify', 'baseline', '--command', command, '--cwd', '.', '--healthy-exit-code', '-1'],
    ['verify', 'baseline', '--command', command, '--cwd', '.', '--repeat', '0'],
    ['run', command, '--capture-context=true'], ['run', command, '--context-source'],
  ])('rejects ambiguous verification invocation %j', (...args) => expect(() => parseArgs(args)).toThrow());
});

describe('built Verify CLI', () => {
  it('reports observed, healthy not-observed and unrelated-error outcomes with clean durable JSON', async () => {
    const cwd = await project();
    const before = await invoke(['run', command, '--cwd', cwd, '--repeat', '2', '--timeout', '5s', '--stderr-contains', predicate.value,
      '--context-input', 'input.json', '--context-setup', 'setup.json', '--context-source', 'target.mjs', '--json'], cwd);
    expect(before.code).toBe(1);
    expect(before.stderr).toBe('');
    const baseline = JSON.parse(before.stdout) as RunSummary;
    expect(baseline).toHaveProperty('context');
    const args = ['verify', baseline.artifactDirectory, '--command', command, '--cwd', cwd];
    const unchanged = await invoke([...args, '--json'], cwd);
    expect(unchanged.code).toBe(1);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ status: 'target_observed', candidate: { matchedTrials: 2, completedTrials: 2 } });

    await writeFile(join(cwd, 'target.mjs'), fixed);
    const undeclared = await invoke([...args, '--json'], cwd);
    expect(undeclared.code).toBe(2);
    expect(JSON.parse(undeclared.stdout).status).toBe('inconclusive');
    const changedArgs = [...args, '--allow-change', 'source:repair target logic'];
    const after = await invoke([...changedArgs, '--json'], cwd);
    expect(after.code).toBe(0);
    expect(after.stderr).toBe('');
    const verification = JSON.parse(after.stdout) as VerifyResult;
    expect(verification).toMatchObject({ status: 'target_not_observed', baselineEligibility: { eligible: true }, candidate: { matchedTrials: 0, healthyTrials: 2, unhealthyTrials: 0, completedTrials: 2, requestedTrials: 2 } });
    expect(JSON.parse(await readFile(verification.metadataPath, 'utf8'))).toEqual(verification);
    const terminal = await invoke(changedArgs, cwd);
    expect(terminal.code).toBe(0);
    expect(terminal.stdout).toContain('does not prove elimination');
    expect(terminal.stdout).toContain('0 target matches / 2 completed / 2 requested');

    await writeFile(join(cwd, 'target.mjs'), unrelated);
    const invalid = await invoke([...changedArgs, '--json'], cwd);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toBe('');
    expect(JSON.parse(invalid.stdout)).toMatchObject({ status: 'inconclusive', candidate: { matchedTrials: 0, unhealthyTrials: 2, unrelatedFailureTrials: 2, infrastructureTrials: 0, invalidEvidenceTrials: 0 } });
  }, 30_000);

  it('rejects a legacy baseline without executing the supplied candidate', async () => {
    const cwd = await project();
    const before = await invoke(['run', command, '--repeat', '1', '--stderr-contains', predicate.value, '--json'], cwd);
    const baseline = JSON.parse(before.stdout) as RunSummary;
    await writeFile(join(cwd, 'target.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('must-not-exist', 'ran');\n");
    const result = await invoke(['verify', baseline.artifactDirectory, '--command', command, '--cwd', cwd, '--allow-change', 'source:changed', '--json'], cwd);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'inconclusive', candidate: null, baselineEligibility: { eligible: false } });
    await expect(readFile(join(cwd, 'must-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('official SDK Verify adapter', () => {
  it('exposes strict execution authority and preserves Core outcomes over stdio', async () => {
    const cwd = await project();
    const client = new Client({ name: 'failtrace-verify-tests', version: '1.0.0' });
    clients.push(client);
    const errors: Error[] = [];
    const stderr: string[] = [];
    client.onerror = (error) => errors.push(error);
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp', '--cwd', cwd], cwd, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    await client.connect(transport);
    const listing = await client.listTools();
    const tool = listing.tools.find((item) => item.name === 'failtrace_verify')!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['baseline', 'command', 'cwd']));
    expect(tool.inputSchema.properties).not.toHaveProperty('predicate');
    expect(tool.annotations?.destructiveHint).toBe(true);
    const baseline = structured(await client.callTool({ name: 'failtrace_run', arguments: { command, repeat: 2, timeoutMs: 5000, predicate, captureContext: context } }));
    expect(baseline).toHaveProperty('context');
    const arguments_ = { baseline: baseline.artifactDirectory, command, cwd };
    const unchanged = structured(await client.callTool({ name: 'failtrace_verify', arguments: arguments_ }));
    expect(unchanged).toMatchObject({ status: 'target_observed', candidate: { matchedTrials: 2 } });
    await writeFile(join(cwd, 'target.mjs'), fixed);
    const changed = { ...arguments_, allowChanges: [{ field: 'source', reason: 'repair target logic' }] };
    const verification = structured(await client.callTool({ name: 'failtrace_verify', arguments: changed }));
    expect(verification).toMatchObject({ status: 'target_not_observed', candidate: { completedTrials: 2, healthyTrials: 2 } });
    const report = JSON.parse(await readFile(verification.metadataPath as string, 'utf8')) as VerifyResult;
    expect(report).toMatchObject({ status: verification.status, candidate: { completedTrials: 2, healthyTrials: 2 } });
    expect(report.baseline?.context?.before.sourceFiles).toHaveLength(1);
    expect(verification).toHaveProperty('baseline.context.before.sourceFiles', 1);
    expect(verification).toHaveProperty('changeDetails');
    await writeFile(join(cwd, 'target.mjs'), unrelated);
    expect(structured(await client.callTool({ name: 'failtrace_verify', arguments: changed })))
      .toMatchObject({ status: 'inconclusive', candidate: { matchedTrials: 0, unhealthyTrials: 2 } });
    const missingAuthority = await client.callTool({ name: 'failtrace_verify', arguments: { baseline: baseline.artifactDirectory, command } });
    expect(missingAuthority.isError).toBe(true);

    const reports = join(cwd, '.failtrace', 'verifications');
    const previous = new Set(await readdir(reports));
    await writeFile(join(cwd, 'target.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('verify-child.pid', String(process.pid)); setInterval(() => {}, 1000);\n");
    const controller = new AbortController();
    const outcome = client.callTool({ name: 'failtrace_verify', arguments: changed }, { signal: controller.signal, timeout: 20_000 })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    const childPid = Number(await waitForFile(join(cwd, 'verify-child.pid')));
    const created = (await readdir(reports)).filter((id) => !previous.has(id));
    expect(created).toHaveLength(1);
    controller.abort();
    expect(await outcome).toHaveProperty('error');
    const deadline = Date.now() + 10_000;
    let partial: VerifyResult;
    do {
      partial = JSON.parse(await readFile(join(reports, created[0]!, 'verify.json'), 'utf8')) as VerifyResult;
      if (partial.endedAt) break;
      await delay(25);
    } while (Date.now() < deadline);
    expect(partial!).toMatchObject({ status: 'interrupted', candidate: { completedTrials: 1, requestedTrials: 2, matchedTrials: 0, unhealthyTrials: 1, infrastructureTrials: 1, unrelatedFailureTrials: 0 } });
    await waitForProcessExit(childPid);
    expect(errors).toEqual([]);
    expect(stderr.join('')).toBe('');
  }, 30_000);
});

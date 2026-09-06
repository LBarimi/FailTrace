import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { assessRun, bisectRegression, compareRuns, createBundle, inspectRunEvidence, loadRun, minimizeFailure, runTrials, verifyFix, type RunOptions } from '../src/core/index.js';
import { parseArgs } from '../src/cli/args.js';
import { cleanupDirectories, cliPath, quoteShellArgument, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const directories: string[] = [];
const clients: Client[] = [];
const fixture = fileURLToPath(new URL('./fixtures/nunit-command.mjs', import.meta.url));
const predicate = { kind: 'nunit_test' as const, fullName: 'Game.SaveRoundTrip', messageContains: 'ITEM_LOST' };
const args = (mode: string) => ['check.mjs', mode, '{testReport}'];
async function workspace() {
  const cwd = await temporaryDirectory(); directories.push(cwd);
  await copyFile(fixture, join(cwd, 'check.mjs')); return cwd;
}
function run(cwd: string, mode: string, extra: Partial<RunOptions> = {}) {
  return runTrials({ command: process.execPath, args: args(mode), cwd, repeat: 2, predicate, ...extra });
}
async function invoke(arguments_: string[], cwd: string) {
  try { return { ...await execute(process.execPath, arguments_, { cwd, windowsHide: true, timeout: 15000 }), code: 0 }; }
  catch (error) { if (typeof (error as { code?: unknown }).code !== 'number') throw error;
    return error as { stdout: string; stderr: string; code: number }; }
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await cleanupDirectories(directories);
});

describe('NUnit experiments through Core, CLI and MCP', () => {
  it('finds a regression using NUnit evidence from separate Git worktrees', async () => {
    const cwd = await workspace();
    const git = async (...arguments_: string[]) => (await execute('git', arguments_, { cwd, windowsHide: true, timeout: 10000 })).stdout.trim();
    await git('init');
    await git('config', 'user.name', 'FailTrace Test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, '.gitignore'), '.failtrace/\n');
    const body = await readFile(fixture, 'utf8');
    await writeFile(join(cwd, 'check.mjs'), body.replace("const mode = process.argv[2] ?? 'failed';", "const mode = 'passed';"));
    await git('add', '.'); await git('commit', '-m', 'Passing test');
    const good = await git('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'check.mjs'), body);
    await git('add', '.'); await git('commit', '-m', 'Introduce selected failure');
    const bad = await git('rev-parse', 'HEAD');
    const result = await bisectRegression({ command: process.execPath, args: args('failed'), cwd, predicate, good, bad, repeat: 1 });
    expect(result).toMatchObject({ status: 'found', firstBad: bad });
  });
  it('includes the selected test outcomes in comparisons even when console output is empty', async () => {
    const cwd = await workspace();
    const before = await run(cwd, 'failed', { repeat: 1 });
    const after = await run(cwd, 'passed', { repeat: 1 });
    const result = await compareRuns({ runA: before.artifactDirectory, runB: after.artifactDirectory });
    expect(JSON.stringify(result)).toContain('"outcome":"failed"');
    expect(JSON.stringify(result)).toContain('"outcome":"passed"');
  });
  it('assigns a different fresh report to every concurrent trial and preserves the command template', async () => {
    const cwd = await workspace();
    const result = await run(cwd, 'failed', { concurrency: 2 });
    expect(assessRun(result)).toBe('reproduced');
    expect(result.trials.every(trial => trial.unitTest?.outcome === 'failed')).toBe(true);
    expect(new Set(result.trials.map(trial => trial.unitTest!.reportPath)).size).toBe(2);
    expect(result.trials.every(trial => JSON.stringify(trial.args) === JSON.stringify(result.args))).toBe(true);
    expect((await loadRun(result.artifactDirectory)).trials[0]!.unitTest?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['missing', 'skipped', 'absent', 'unrelated', 'different', 'invalid', 'bad-exit'])('keeps %s evidence inconclusive without crashing the operation', async mode => {
    const cwd = await workspace();
    const result = await run(cwd, mode);
    expect(assessRun(result)).toBe('inconclusive');
    expect(result.trials[0]).toMatchObject({ failureMatched: false, unitTest: { outcome: 'inconclusive', reason: expect.any(String) } });
    const inspected = await inspectRunEvidence({ view: 'trials', run: result.artifactDirectory, filter: 'unhealthy' });
    expect(inspected).toMatchObject({ trials: [{ unitTest: { outcome: 'inconclusive' }, unhealthy: true }] });
  });
  it('cannot reuse an earlier result file when a later trial writes nothing', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'check.mjs'), `if (process.env.FAILTRACE_TRIAL_INDEX === '2') process.exit(0);\n${await readFile(fixture, 'utf8')}`);
    const result = await run(cwd, 'passed');
    expect(result.trials.map(trial => trial.unitTest?.outcome)).toEqual(['passed', 'inconclusive']);
    expect(assessRun(result)).toBe('inconclusive');
  });
  it.each(['passed', 'skipped', 'unrelated', 'missing'])('carries the exact test identity and message into Verify: %s', async mode => {
    const cwd = await workspace();
    const baseline = await run(cwd, 'failed', { repeat: 1, captureContext: { sourceFiles: ['check.mjs'] } });
    const candidate = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command: process.execPath, args: args(mode),
      allowChanges: [{ field: 'command', reason: 'Select the controlled candidate outcome.' }] });
    expect(candidate.plan.predicate).toEqual(predicate);
    expect(candidate.candidate).not.toBeNull();
    expect(candidate.status).toBe(mode === 'passed' ? 'target_not_observed' : 'inconclusive');
  });
  it('refuses altered saved XML even when its target outcome remains the same', async () => {
    const cwd = await workspace();
    const baseline = await run(cwd, 'failed', { repeat: 1, captureContext: { sourceFiles: ['check.mjs'] } });
    const report = join(baseline.artifactDirectory, baseline.trials[0]!.unitTest!.reportPath!);
    await writeFile(report, (await readFile(report, 'utf8')).replace('ITEM_LOST', 'ITEM_LOST edited'));
    const candidate = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command: process.execPath, args: args('failed') });
    expect(candidate.status).toBe('inconclusive');
    expect(candidate.candidate).toBeNull();
  });
  it('rejects undeclared metadata fields before projecting test evidence into an agent response', async () => {
    const cwd = await workspace();
    const before = await run(cwd, 'failed', { repeat: 1 });
    const path = join(before.artifactDirectory, 'trials/001/result.json');
    const original = before.trials[0]!;
    for (const extra of [{ ...original.unitTest, payload: 'unbounded external data' },
      { ...original.unitTest, counts: { ...original.unitTest!.counts, payload: 'unexpected' } }]) {
      const changed = { ...original, unitTest: extra };
      await writeFile(path, JSON.stringify(changed));
      // Small runs embed trials in run.json; large runs load individual records.
      for (const header of [{ ...before, trials: [changed] },
        { ...before, schemaVersion: 2, trialStorage: 'individual', trialCount: 1, trials: [] }]) {
        await writeFile(join(before.artifactDirectory, 'run.json'), JSON.stringify(header));
        await expect(loadRun(before.artifactDirectory)).rejects.toThrow('Invalid NUnit evidence');
      }
    }
  });
  it('accepts an environment-based wrapper and excludes results from truncated execution', async () => {
    const cwd = await workspace();
    const command = `${quoteShellArgument(process.execPath)} check.mjs failed`;
    expect(assessRun(await runTrials({ command, cwd, predicate, repeat: 1 }))).toBe('reproduced');
    await writeFile(join(cwd, 'check.mjs'), `${await readFile(fixture, 'utf8')}\nprocess.stdout.write('x'.repeat(10000));`);
    const truncated = await run(cwd, 'passed', { repeat: 1, maxOutputBytes: 100 });
    expect(assessRun(truncated)).toBe('inconclusive');
    expect(truncated.trials[0]!.unitTest!.outcome).toBe('inconclusive');
  });
  it('minimizes an input using the NUnit target and replays a relocated bundle without npm installation', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'input.txt'), 'aXb');
    const minimized = await minimizeFailure({ command: process.execPath, args: [...args('input'), '{input}'], cwd, predicate,
      input: 'input.txt', format: 'text', repeat: 1, maxEvaluations: 20 });
    expect(minimized).toMatchObject({ finalVerified: true, minimizedSize: 1 });
    const baseline = await run(cwd, 'failed', { repeat: 1 });
    const bundle = await createBundle({ run: baseline.artifactDirectory, cwd, command: 'node', args: args('failed'), files: ['check.mjs'], includeEvidence: true });
    const manifest = JSON.parse(await readFile(bundle.manifestPath, 'utf8')) as { files: { path: string }[] };
    expect(manifest.files.some(file => file.path.endsWith('test-results.xml'))).toBe(true);
    expect(manifest.files.some(file => file.path === 'node_modules/saxes/saxes.js')).toBe(true);
    const replay = await invoke([join(bundle.directory, 'repro.mjs')], cwd);
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain('Target failure reproduced: 1 / 1');
  });
  it('exposes CLI flags, JSON evidence and an inconclusive exit code', async () => {
    const cwd = await workspace();
    expect(parseArgs(['run', 'unused', '--nunit-test', predicate.fullName, '--nunit-message', 'ITEM_LOST'])).toMatchObject({ predicate });
    expect(() => parseArgs(['run', 'unused', '--nunit-message', 'ITEM_LOST'])).toThrow('requires');
    for (const [mode, code] of [['failed', 1], ['passed', 0], ['missing', 2]] as const) {
      const response = await invoke([cliPath, 'run', '--exec', process.execPath, ...args(mode).flatMap(arg => ['--arg', arg]),
        '--nunit-test', predicate.fullName, '--repeat', '1', '--json'], cwd);
      expect(response.code).toBe(code);
      expect(JSON.parse(response.stdout).trials[0].unitTest.outcome).toBe(mode === 'missing' ? 'inconclusive' : mode);
    }
    const text = await invoke([cliPath, 'run', '--exec', process.execPath, ...args('missing').flatMap(arg => ['--arg', arg]),
      '--nunit-test', predicate.fullName, '--repeat', '1'], cwd);
    expect(text.code).toBe(2);
    expect(text.stdout).toContain('Run inconclusive: NUnit test evidence is incomplete or unhealthy.');
  });
  it('lets an MCP agent run, inspect and verify the same NUnit test with bounded structured evidence', async () => {
    const cwd = await workspace();
    const client = new Client({ name: 'nunit-evidence-test', version: '1.0.0' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp', '--cwd', cwd], stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(JSON.stringify(tools.tools.find(tool => tool.name === 'failtrace_run')!.inputSchema)).toContain('nunit_test');
    const before = await client.callTool({ name: 'failtrace_run', arguments: { command: process.execPath, args: args('failed'), predicate,
      repeat: 1, captureContext: { sourceFiles: ['check.mjs'] } } });
    expect(before.isError).toBe(false);
    expect(before.structuredContent).toMatchObject({ assessment: 'reproduced', unitTests: { failed: 1, passed: 0, inconclusive: 0 } });
    const baseline = String((before.structuredContent as Record<string, unknown>).artifactDirectory);
    const inspected = await client.callTool({ name: 'failtrace_inspect_run', arguments: { view: 'trials', run: baseline } });
    expect(inspected.structuredContent).toMatchObject({ trials: [{ unitTest: { fullName: predicate.fullName, outcome: 'failed' } }] });
    const candidate = await client.callTool({ name: 'failtrace_verify', arguments: { baseline, cwd, command: process.execPath, args: args('passed'),
      allowChanges: [{ field: 'command', reason: 'Select passing control.' }] } });
    expect(candidate.structuredContent).toMatchObject({ status: 'target_not_observed', plan: { predicate } });
    expect(stderr).toBe('');
  });
});

import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessRun, loadRun, minimizeFailure, runTrials, verifyFix } from '../src/core/index.js';
import type { RunSummary } from '../src/core/index.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory, waitForProcessExit } from './helpers.js';

const directories: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/output.mjs', import.meta.url));
const command = (...args: string[]) => [process.execPath, fixture, ...args].map(quoteShellArgument).join(' ');
async function workspace(): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  return cwd;
}
async function outputBytes(run: RunSummary): Promise<number> {
  const sizes = await Promise.all(run.trials.flatMap((trial) => [trial.stdoutPath, trial.stderrPath])
    .map(async (path) => (await fs.stat(join(run.artifactDirectory, path))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}
afterEach(async () => { vi.restoreAllMocks(); await cleanupDirectories(directories); });

describe('bounded output evidence', () => {
  it('retains an exact prefix and never calls an omitted signature a healthy nonmatch', async () => {
    const run = await runTrials({ cwd: await workspace(), command: command('target', '64'), repeat: 3,
      maxOutputBytes: 32, predicate: { kind: 'stderr_contains', value: 'TARGET' } });
    expect(run.status).toBe('resource_limited');
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]).toMatchObject({ status: 'resource_limited', terminationReason: 'output_limit', failureMatched: false,
      outputLimit: { scope: 'trial', limitBytes: 32 } });
    expect(await outputBytes(run)).toBe(32);
    expect(assessRun(run)).toBe('inconclusive');
    expect(await loadRun(run.artifactDirectory)).toEqual({ ...run, artifactDirectory: await fs.realpath(run.artifactDirectory) });
  });

  it('accepts exactly the configured byte count and reports an overrun at the next byte', async () => {
    const cwd = await workspace();
    const exact = await runTrials({ cwd, command: command('exact', '32'), repeat: 2, maxOutputBytes: 32, maxTotalOutputBytes: 64 });
    expect(assessRun(exact)).toBe('not_reproduced');
    expect(await outputBytes(exact)).toBe(64);
    const over = await runTrials({ cwd, command: command('exact', '33'), repeat: 1, maxOutputBytes: 32 });
    expect(assessRun(over)).toBe('inconclusive');
    expect(await outputBytes(over)).toBe(32);
  });

  it('counts bytes across stdout/stderr and preserves a truncated UTF-8 sequence as raw evidence', async () => {
    const cwd = await workspace();
    const split = await runTrials({ cwd, command: command('target', '20'), repeat: 1, maxOutputBytes: 22 });
    expect(split.status).toBe('resource_limited');
    expect(await outputBytes(split)).toBe(22);
    const unicode = await runTrials({ cwd, command: command('unicode'), repeat: 1, maxOutputBytes: 2,
      predicate: { kind: 'stdout_contains', value: 'TARGET' } });
    expect(await fs.readFile(join(unicode.artifactDirectory, unicode.trials[0]!.stdoutPath))).toEqual(Buffer.from([0xe2, 0x82]));
    expect(assessRun(unicode)).toBe('inconclusive');
  });

  it('shares the total cap between concurrent streams and does not schedule the remaining trials', async () => {
    const run = await runTrials({ cwd: await workspace(), command: command('target', '128'), repeat: 12,
      concurrency: 3, maxOutputBytes: 128, maxTotalOutputBytes: 96 });
    expect(run.status).toBe('resource_limited');
    expect(await outputBytes(run)).toBe(96);
    expect(run.trials.length).toBeLessThanOrEqual(3);
    expect(run.trials.some((trial) => trial.outputLimit?.scope === 'experiment')).toBe(true);
    expect(assessRun(run)).toBe('inconclusive');
  });

  it('terminates descendants that keep producing output and persists the bounded evidence', async () => {
    const cwd = await workspace();
    const pidFile = join(cwd, 'descendant.pid');
    const run = await runTrials({ cwd, command: command('tree', pidFile), repeat: 1, maxOutputBytes: 1024, timeoutMs: 5000 });
    expect(run.status).toBe('resource_limited');
    expect(await outputBytes(run)).toBe(1024);
    await waitForProcessExit(Number(await fs.readFile(pidFile, 'utf8')));
  });

  it('treats a disk write failure as incomplete evidence, including with an exit predicate', async () => {
    const cwd = await workspace();
    const handle = await fs.open(join(cwd, 'probe'), 'wx');
    const prototype = Object.getPrototypeOf(handle) as fs.FileHandle;
    await handle.close();
    vi.spyOn(prototype, 'write').mockRejectedValue(Object.assign(new Error('Simulated output storage failure'), { code: 'ENOSPC' }));
    const run = await runTrials({ cwd, command: command('target', '32'), repeat: 2 });
    expect(run.status).toBe('error');
    expect(run.trials[0]).toMatchObject({ status: 'output_error', failureMatched: false, terminationReason: 'output_error' });
    expect(assessRun(run)).toBe('inconclusive');
    expect(await loadRun(run.artifactDirectory)).toEqual({ ...run, artifactDirectory: await fs.realpath(run.artifactDirectory) });
  });

  it('shares one output budget across minimization candidates and never claims final verification after exhaustion', async () => {
    const cwd = await workspace();
    await fs.writeFile(join(cwd, 'input.txt'), 'BUG noise');
    const result = await minimizeFailure({ cwd, input: 'input.txt', format: 'text', command: command('target', '10'),
      maxOutputBytes: 32, maxTotalOutputBytes: 20 });
    expect(result.status).toBe('inconclusive');
    expect(result.finalVerified).toBe(false);
    expect(result.final).toBeUndefined();
    expect(result.evaluations).toHaveLength(2);
    const bytes = await Promise.all(result.evaluations.map(async (evaluation) => outputBytes(await loadRun(evaluation.runDirectory))));
    expect(bytes.reduce((sum, size) => sum + size, 0)).toBe(20);
  });

  it('inherits baseline caps, refuses undeclared cap changes and rejects a noisy false fix', async () => {
    const cwd = await workspace();
    await fs.writeFile(join(cwd, 'target.mjs'), "console.error('TARGET'); process.exitCode = 7;\n");
    const target = `${quoteShellArgument(process.execPath)} target.mjs`;
    const baseline = await runTrials({ cwd, command: target, repeat: 1, maxOutputBytes: 16, maxTotalOutputBytes: 32,
      captureContext: { sourceFiles: ['target.mjs'] }, predicate: { kind: 'stderr_contains', value: 'TARGET' } });
    const changed = await verifyFix({ cwd, command: target, baseline: baseline.artifactDirectory, maxOutputBytes: 8 });
    expect(changed).toMatchObject({ status: 'inconclusive', candidate: null,
      changes: [expect.objectContaining({ field: 'outputLimits', allowed: false })] });
    await fs.writeFile(join(cwd, 'target.mjs'), "process.stdout.write('x'.repeat(64));\n");
    const result = await verifyFix({ cwd, command: target, baseline: baseline.artifactDirectory,
      allowChanges: [{ field: 'source', reason: 'Candidate implementation' }] });
    expect(result).toMatchObject({ status: 'inconclusive', plan: { maxOutputBytes: 16, maxTotalOutputBytes: 32 },
      candidate: { matchedTrials: 0, healthyTrials: 0, infrastructureTrials: 1 } });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid byte budgets before creating artifacts: %s', async (value) => {
    const cwd = await workspace();
    await expect(runTrials({ cwd, command: command('exact', '1'), maxOutputBytes: value })).rejects.toThrow('positive safe integer');
    await expect(runTrials({ cwd, command: command('exact', '1'), maxTotalOutputBytes: value })).rejects.toThrow('positive safe integer');
    expect(await fs.readdir(cwd)).toEqual([]);
  });
});

import { appendFile, mkdir, open, readFile, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrials } from '../src/core/run-trials.js';
import { compareRuns } from '../src/core/compare.js';
import { loadRun, safeArtifactPath } from '../src/core/run-reader.js';
import { cleanupDirectories, fixtureCommand, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
async function workspace(): Promise<string> { const cwd = await temporaryDirectory(); directories.push(cwd); return cwd; }
afterEach(async () => cleanupDirectories(directories));

describe('run comparison', () => {
  it('prefers the target match over an earlier timeout and preserves explicit selection', async () => {
    const run = await runTrials({ command: fixtureCommand('compare-mixed'), repeat: 3, timeoutMs: 1_500,
      predicate: { kind: 'stderr_contains', value: 'comparison target' }, cwd: await workspace() });
    const comparison = await compareRuns({ runA: run.artifactDirectory });
    expect(comparison).toMatchObject({ trialA: 1, trialB: 3, warnings: [],
      selectedTrials: { a: { exitCode: 0, failureMatched: false }, b: { exitCode: 7, failureMatched: true } } });
    expect(comparison.stderr.diff).toContain('+comparison target');
    const explicit = await compareRuns({ runA: run.artifactDirectory, trialB: 2 });
    expect(explicit).toMatchObject({ trialB: 2, selectedTrials: { b: { status: 'timed_out', failureMatched: false } } });
    expect(explicit.warnings?.[0]).toContain('unhealthy execution');
    // Explicitly comparing separate runs still starts from their first trial.
    expect(await compareRuns({ runA: run.artifactDirectory, runB: run.artifactDirectory })).toMatchObject({ trialA: 1, trialB: 1 });
  });

  it('keeps infrastructure evidence inspectable with a warning when there is no target match', async () => {
    const run = await runTrials({ command: fixtureCommand('compare-mixed'), repeat: 2, timeoutMs: 1_500,
      predicate: { kind: 'stderr_contains', value: 'comparison target' }, cwd: await workspace() });
    const result = await compareRuns({ runA: run.artifactDirectory });
    expect(result).toMatchObject({ trialA: 1, trialB: 2, selectedTrials: { b: { status: 'timed_out' } } });
    expect(result.warnings?.[0]).toContain('do not interpret this difference as the target failure');
  });

  it('compares PASS and FAIL evidence within one run by ID', async () => {
    const cwd = await workspace();
    const run = await runTrials({ command: fixtureCommand('alternate'), repeat: 2, cwd });
    const comparison = await compareRuns({ runA: run.id, cwd });
    expect(comparison).toMatchObject({ runA: run.id, runB: run.id, trialA: 1, trialB: 2, concurrencyChanged: false });
    expect(comparison.stdout.equal).toBe(false);
    expect(comparison.stdout.diff).toContain('-trial 1');
    expect(comparison.stdout.diff).toContain('+trial 2');
    expect(comparison.stderr.equal).toBe(true);
  });

  it('compares separate runs, full-output hashes, statistics and selected environment', async () => {
    const cwd = await workspace();
    const first = await runTrials({ command: fixtureCommand('pass'), repeat: 1, cwd,
      captureEnv: ['VARIANT'], env: { VARIANT: 'A' } });
    const second = await runTrials({ command: fixtureCommand('fail'), repeat: 1, concurrency: 2, cwd,
      captureEnv: ['VARIANT'], env: { VARIANT: 'B' } });
    const comparison = await compareRuns({ runA: first.artifactDirectory, runB: join(second.artifactDirectory, 'run.json') });
    expect(comparison.failureRateDelta).toBe(1);
    expect(comparison.commandChanged).toBe(true);
    expect(comparison.concurrencyChanged).toBe(true);
    expect(comparison.stdout.sha256A).toMatch(/^[a-f0-9]{64}$/);
    expect(comparison.environmentChanges).toContainEqual({ key: 'variables.VARIANT', before: 'A', after: 'B' });
    const bounded = await compareRuns({ runA: first.artifactDirectory, runB: second.artifactDirectory, maxBytes: 3, maxLines: 2 });
    expect(bounded.stdout.truncated).toBe(true);
    expect(bounded.stdout.sha256A).toBe(comparison.stdout.sha256A);
    expect(bounded.stdout.diff.length).toBeLessThanOrEqual(2);
  });

  it('reports identical streams without a redundant diff', async () => {
    const run = await runTrials({ command: fixtureCommand('pass'), repeat: 2, cwd: await workspace() });
    const comparison = await compareRuns({ runA: run.artifactDirectory, trialA: 1, trialB: 2 });
    expect(comparison.stdout).toMatchObject({ equal: true, diff: [], truncated: false });
    await expect(compareRuns({ runA: run.artifactDirectory })).rejects.toThrow(/no failed/);
    await expect(compareRuns({ runA: run.artifactDirectory, trialA: 5 })).rejects.toThrow(/does not exist/);
  });

  it('preserves complete diff prefixes across short filesystem reads', async () => {
    const run = await runTrials({ command: fixtureCommand('alternate'), repeat: 2, cwd: await workspace() });
    await writeFile(join(run.artifactDirectory, run.trials[0]!.stdoutPath), 'first complete output\n');
    await writeFile(join(run.artifactDirectory, run.trials[1]!.stdoutPath), 'second complete output\n');
    const probe = await open(join(run.artifactDirectory, run.trials[0]!.stdoutPath), 'r');
    type BufferRead = (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number | null) => Promise<{ bytesRead: number; buffer: Buffer }>;
    const prototype = Object.getPrototypeOf(probe) as { read: BufferRead };
    const original = prototype.read;
    await probe.close();
    prototype.read = function (buffer, offset, length, position) {
      return original.call(this, buffer, offset, Math.min(length, 3), position);
    };
    try {
      const comparison = await compareRuns({ runA: run.artifactDirectory });
      expect(comparison.stdout).toMatchObject({ truncated: false, diff: ['-first complete output', '+second complete output', ' '] });
    } finally { prototype.read = original; }
  });

  it.each(['growth', 'replacement'] as const)('rejects output %s while hashing instead of mixing evidence snapshots', async change => {
    const run = await runTrials({ command: fixtureCommand('alternate'), repeat: 2, cwd: await workspace() });
    const path = join(run.artifactDirectory, run.trials[0]!.stdoutPath);
    const contents = await readFile(path);
    const probe = await open(path, 'r');
    const identity = await probe.stat({ bigint: true });
    type BufferRead = (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number | null) => Promise<{ bytesRead: number; buffer: Buffer }>;
    const prototype = Object.getPrototypeOf(probe) as { read: BufferRead };
    const original = prototype.read;
    await probe.close();
    let changed = false;
    prototype.read = async function (buffer, offset, length, position) {
      const result = await original.call(this, buffer, offset, length, position);
      const current = await this.stat({ bigint: true });
      if (!changed && current.dev === identity.dev && current.ino === identity.ino) {
        changed = true;
        if (change === 'growth') await appendFile(path, 'unexpected extra output');
        else { await rename(path, `${path}.original`); await writeFile(path, contents); }
      }
      return result;
    };
    try {
      await expect(compareRuns({ runA: run.artifactDirectory })).rejects.toThrow(/changed/);
      expect(changed).toBe(true);
    } finally { prototype.read = original; }
  });

  it('rejects a non-regular output before opening it as a stream', async () => {
    const run = await runTrials({ command: fixtureCommand('alternate'), repeat: 2, cwd: await workspace() });
    const path = join(run.artifactDirectory, run.trials[0]!.stdoutPath);
    await rm(path);
    await mkdir(path);
    await expect(compareRuns({ runA: run.artifactDirectory })).rejects.toThrow(/regular file/);
  });

  it('rejects unsafe artifact paths from saved metadata', async () => {
    const run = await runTrials({ command: fixtureCommand('alternate'), repeat: 2, cwd: await workspace() });
    run.trials[0]!.stdoutPath = '../outside.txt';
    await writeFile(join(run.artifactDirectory, 'run.json'), JSON.stringify(run));
    await expect(compareRuns({ runA: run.artifactDirectory })).rejects.toThrow(/Unsafe artifact/);
    await expect(safeArtifactPath(run.artifactDirectory, 'C:\\secret')).rejects.toThrow(/relative path/);
    await expect(safeArtifactPath(run.artifactDirectory, '/secret')).rejects.toThrow(/relative path/);
  });

  it('validates run schema and relocates stale artifactDirectory metadata', async () => {
    const run = await runTrials({ command: fixtureCommand('pass'), repeat: 1, cwd: await workspace() });
    const path = join(run.artifactDirectory, 'run.json');
    const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    metadata.artifactDirectory = 'old-computer';
    await writeFile(path, JSON.stringify(metadata));
    expect(await realpath((await loadRun(path)).artifactDirectory)).toBe(await realpath(run.artifactDirectory));
    metadata.schemaVersion = 999;
    await writeFile(path, JSON.stringify(metadata));
    await expect(loadRun(path)).rejects.toThrow(/metadata/);
  });
});

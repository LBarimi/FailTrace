import { access, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrials } from '../src/core/run-trials.js';
import { loadRun } from '../src/core/run-reader.js';
import { cleanupDirectories, fixtureCommand, quoteShellArgument, temporaryDirectory, waitForFile, waitForProcessExit } from './helpers.js';

const directories: string[] = [];
async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}
function command(cwd: string, mode = 'ordered'): string {
  return [process.execPath, fileURLToPath(new URL('./fixtures/concurrent.mjs', import.meta.url)), cwd, mode]
    .map(quoteShellArgument).join(' ');
}
afterEach(async () => cleanupDirectories(directories));

describe('concurrent trials', () => {
  it('bounds active work, notifies durable completion order, returns index ordered evidence', async () => {
    const cwd = await workspace();
    const completed: number[] = [];
    const run = await runTrials({ command: command(cwd), cwd, repeat: 4, concurrency: 2,
      onTrialComplete: async (trial) => {
        completed.push(trial.index);
        if (completed.length === 1) {
          expect(trial.index).toBe(2);
          await expect(access(join(cwd, 'started-3'))).rejects.toThrow();
          const [id] = await readdir(join(cwd, '.failtrace', 'runs'));
          const partial = await loadRun(join(cwd, '.failtrace', 'runs', id!));
          expect(partial.status).toBe('running');
          expect(partial.trials.map(({ index }) => index)).toEqual([2]);
          await writeFile(join(cwd, 'release-first'), 'go');
        }
      },
    });
    expect(completed[0]).toBe(2);
    expect(run.concurrency).toBe(2);
    expect(run.trials.map(({ index }) => index)).toEqual([1, 2, 3, 4]);
    expect(run.statistics).toMatchObject({ total: 4, passed: 4 });
    expect(await loadRun(run.artifactDirectory)).toEqual({
      ...run, artifactDirectory: await realpath(run.artifactDirectory),
    });
  });

  it('cancels every active process and schedules no replacement trials', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const running = runTrials({ command: command(cwd, 'hang'), cwd, repeat: 10, concurrency: 3,
      timeoutMs: 10_000, signal: controller.signal });
    let pids: number[] = [];
    try {
      pids = await Promise.all([1, 2, 3].map(async (index) => Number(await waitForFile(join(cwd, `started-${index}`)))));
    } finally { controller.abort(); }
    const run = await running;
    expect(run.status).toBe('interrupted');
    expect(run.trials).toHaveLength(3);
    expect(run.trials.every(({ status }) => status === 'interrupted')).toBe(true);
    await Promise.all(pids.map(waitForProcessExit));
    await expect(access(join(cwd, 'started-4'))).rejects.toThrow();
  });

  it('waits for other active trial cleanup before rejecting an observer failure', async () => {
    const cwd = await workspace();
    await expect(runTrials({ command: command(cwd), cwd, repeat: 4, concurrency: 2,
      onTrialComplete: () => { throw new Error('observer failed'); },
    })).rejects.toThrow('observer failed');
    await waitForProcessExit(Number(await waitForFile(join(cwd, 'started-1'))));
    const [id] = await readdir(join(cwd, '.failtrace', 'runs'));
    const run = await loadRun(join(cwd, '.failtrace', 'runs', id!));
    expect(run).toMatchObject({ status: 'error', statistics: { total: 2 } });
    expect(run.trials.map(({ index }) => index)).toEqual([1, 2]);
    await expect(access(join(cwd, 'started-3'))).rejects.toThrow();
  });

  it('retains timeout evidence for each parallel trial', async () => {
    const run = await runTrials({ command: fixtureCommand('hang'), cwd: await workspace(),
      repeat: 4, concurrency: 2, timeoutMs: 100 });
    expect(run.statistics.total).toBe(4);
    expect(run.trials.every(({ timedOut }) => timedOut)).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid concurrency %s before artifacts', async (concurrency) => {
    const cwd = await workspace();
    await expect(runTrials({ command: fixtureCommand('pass'), cwd, concurrency })).rejects.toThrow(/concurrency/i);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('keeps classification sequential and validates its threshold', async () => {
    const cwd = await workspace();
    await expect(runTrials({ command: fixtureCommand('pass'), cwd, concurrency: 2,
      stopWhenDecided: { minFailures: 1 } })).rejects.toThrow(/concurrency one/);
    await expect(runTrials({ command: fixtureCommand('pass'), cwd, repeat: 2,
      stopWhenDecided: { minFailures: 3 } })).rejects.toThrow(/minFailures/);
    expect(await readdir(cwd)).toEqual([]);
  });
});

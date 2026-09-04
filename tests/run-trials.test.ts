import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrials } from '../src/core/run-trials.js';
import { runTrial } from '../src/core/runner.js';
import type { RunOptions, RunSummary } from '../src/core/types.js';
import {
  cleanupDirectories, fixtureCommand, readJson, temporaryDirectory, waitForFile, waitForProcessExit,
} from './helpers.js';

const directories: string[] = [];

async function workspace(): Promise<string> {
  const path = await temporaryDirectory();
  directories.push(path);
  return path;
}

afterEach(async () => cleanupDirectories(directories));

describe('runTrials', () => {
  it('executes a successful command and preserves stdout, stderr, and timestamps', async () => {
    const cwd = await workspace();
    const summary = await runTrials({ command: fixtureCommand('pass'), repeat: 1, cwd });
    const result = summary.trials[0]!;

    expect(summary.status).toBe('completed');
    expect(summary.statistics).toMatchObject({ total: 1, passed: 1, failed: 0, failureRate: 0 });
    expect(result).toMatchObject({
      index: 1, exitCode: 0, status: 'passed', timedOut: false, spawningFailed: false,
      terminationReason: 'exit', command: fixtureCommand('pass'),
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Date.parse(result.startedAt))).toBe(true);
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(await readFile(join(summary.artifactDirectory, result.stdoutPath), 'utf8')).toBe('success: 안녕하세요\n');
    expect(await readFile(join(summary.artifactDirectory, result.stderrPath), 'utf8')).toBe('diagnostic output\n');
  });

  it('records nonzero command exits as trial failures without throwing', async () => {
    const summary = await runTrials({ command: fixtureCommand('fail'), repeat: 2, cwd: await workspace() });
    expect(summary.trials.map(({ exitCode }) => exitCode)).toEqual([7, 7]);
    expect(summary.trials.map(({ status }) => status)).toEqual(['failed', 'failed']);
    expect(summary.statistics).toMatchObject({ total: 2, passed: 0, failed: 2, failureRate: 1 });
    expect(await readFile(join(summary.artifactDirectory, summary.trials[0]!.stderrPath), 'utf8')).toBe('expected failure\n');
  });

  it('repeats sequentially with a one-based trial environment and stable counts', async () => {
    const completed: number[] = [];
    const summary = await runTrials({
      command: fixtureCommand('alternate'), repeat: 4, cwd: await workspace(),
      onTrialComplete: (trial) => completed.push(trial.index),
    });
    expect(completed).toEqual([1, 2, 3, 4]);
    expect(summary.trials.map(({ status }) => status)).toEqual(['passed', 'failed', 'passed', 'failed']);
    expect(summary.statistics).toMatchObject({ total: 4, passed: 2, failed: 2, failureRate: 0.5 });
    expect(await Promise.all(summary.trials.map((trial) => readFile(join(summary.artifactDirectory, trial.stdoutPath), 'utf8'))))
      .toEqual(['trial 1\n', 'trial 2\n', 'trial 3\n', 'trial 4\n']);
  });

  it('writes inspectable run and trial metadata without duplicating output', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'unrelated.txt'), 'keep me');
    const summary = await runTrials({ command: fixtureCommand('pass'), repeat: 2, timeoutMs: 4_000, cwd });
    const artifactRoot = join(cwd, '.failtrace', 'runs');
    expect(relative(artifactRoot, summary.artifactDirectory)).toBe(summary.id);
    expect(summary).toMatchObject({
      schemaVersion: 1, command: fixtureCommand('pass'), requestedTrials: 2,
      timeoutMs: 4_000, cwd, status: 'completed',
    });
    expect(summary.failtraceVersion.length).toBeGreaterThan(0);
    expect(summary.endedAt).not.toBeNull();
    expect(await readJson(join(summary.artifactDirectory, 'run.json'))).toEqual(summary);
    for (const trial of summary.trials) {
      expect(isAbsolute(trial.stdoutPath)).toBe(false);
      expect(isAbsolute(trial.stderrPath)).toBe(false);
      const resultPath = join(summary.artifactDirectory, trial.stdoutPath, '..', 'result.json');
      const metadata = await readJson(resultPath);
      expect(metadata).toEqual(trial);
      expect(metadata).not.toHaveProperty('stdout');
      expect(metadata).not.toHaveProperty('stderr');
    }
    expect(await readFile(join(cwd, 'unrelated.txt'), 'utf8')).toBe('keep me');
  });

  it('uses independent run directories and a caller-specified artifact root', async () => {
    const cwd = await workspace();
    const artifactsDir = join(cwd, 'custom evidence');
    const first = await runTrials({ command: fixtureCommand('pass'), repeat: 1, cwd, artifactsDir });
    const second = await runTrials({ command: fixtureCommand('fail'), repeat: 1, cwd, artifactsDir });
    expect(first.id).not.toBe(second.id);
    expect(relative(join(artifactsDir, 'runs'), first.artifactDirectory)).toBe(first.id);
    expect(await readJson(join(first.artifactDirectory, 'run.json'))).toEqual(first);
    expect(await readJson(join(second.artifactDirectory, 'run.json'))).toEqual(second);
    expect((await readdir(join(artifactsDir, 'runs'))).sort()).toEqual([first.id, second.id].sort());
  });

  it('passes environment overrides and a working directory containing spaces', async () => {
    const cwd = await workspace();
    const summary = await runTrials({
      command: fixtureCommand('environment'), repeat: 1, cwd,
      env: { FAILTRACE_TEST_VALUE: 'explicit value' },
    });
    expect(summary.statistics.passed).toBe(1);
    expect(await readFile(join(summary.artifactDirectory, summary.trials[0]!.stdoutPath), 'utf8')).toBe(`explicit value\n${cwd}\n`);
  });

  it('handles command-not-found as failure evidence', async () => {
    const summary = await runTrials({
      command: 'failtrace-command-that-does-not-exist-95b78421', repeat: 1, cwd: await workspace(),
    });
    expect(summary.status).toBe('completed');
    expect(summary.statistics.failed).toBe(1);
    expect(summary.trials[0]!.exitCode).not.toBe(0);
    expect(summary.trials[0]!.status).toBe('failed');
    expect((await readFile(join(summary.artifactDirectory, summary.trials[0]!.stderrPath), 'utf8')).length).toBeGreaterThan(0);
  });

  it('records timeout distinctly and proceeds to the next trial', async () => {
    const summary = await runTrials({ command: fixtureCommand('hang'), repeat: 2, timeoutMs: 150, cwd: await workspace() });
    expect(summary.status).toBe('completed');
    expect(summary.statistics).toMatchObject({ total: 2, passed: 0, failed: 2 });
    for (const trial of summary.trials) {
      expect(trial).toMatchObject({ status: 'timed_out', timedOut: true, terminationReason: 'timeout' });
    }
  }, 10_000);

  it('cleans up a descendant process when its trial times out', async () => {
    const cwd = await workspace();
    const marker = join(cwd, 'child heartbeat');
    const running = runTrials({ command: fixtureCommand('tree', marker), repeat: 1, timeoutMs: 2_000, cwd });
    let childPid: number | undefined;
    try {
      childPid = Number(await waitForFile(`${marker}.pid`));
      const summary = await running;
      expect(summary.trials[0]!.timedOut).toBe(true);
      await waitForProcessExit(childPid);
    } finally {
      if (childPid !== undefined) {
        try { process.kill(childPid); } catch { /* It should already be gone. */ }
      }
      await running;
    }
  }, 10_000);

  it('preserves completed trials and an active interrupted trial on AbortSignal', async () => {
    const cwd = await workspace();
    const marker = join(cwd, 'active trial');
    const controller = new AbortController();
    const running = runTrials({
      command: fixtureCommand('interrupt-after-first', marker), repeat: 4,
      timeoutMs: 10_000, cwd, signal: controller.signal,
    });
    try {
      await waitForFile(marker);
    } finally {
      controller.abort();
    }
    const summary = await running;
    expect(summary.status).toBe('interrupted');
    expect(summary.trials.map(({ status }) => status)).toEqual(['passed', 'interrupted']);
    expect(summary.trials[1]).toMatchObject({ timedOut: false, terminationReason: 'interrupted' });
    expect(summary.statistics).toMatchObject({ total: 2, passed: 1, failed: 1, failureRate: 0.5 });
    expect(await readJson(join(summary.artifactDirectory, 'run.json'))).toEqual(summary);
    expect(await readFile(join(summary.artifactDirectory, summary.trials[0]!.stdoutPath), 'utf8')).toBe('trial 1\n');
  }, 10_000);

  it('starts no trials when the AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const summary = await runTrials({
      command: fixtureCommand('fail'), repeat: 3, cwd: await workspace(), signal: controller.signal,
    });
    expect(summary.status).toBe('interrupted');
    expect(summary.trials).toEqual([]);
    expect(summary.statistics.total).toBe(0);
    expect(await readJson(join(summary.artifactDirectory, 'run.json'))).toEqual(summary);
  });

  it('stops before a new trial when aborted by the completed-trial callback', async () => {
    const controller = new AbortController();
    const summary = await runTrials({
      command: fixtureCommand('pass'), repeat: 3, cwd: await workspace(), signal: controller.signal,
      onTrialComplete: () => controller.abort(),
    });
    expect(summary.status).toBe('interrupted');
    expect(summary.trials).toHaveLength(1);
    expect(summary.statistics.passed).toBe(1);
  });

  it('preserves valid metadata and completed evidence when a callback throws', async () => {
    const cwd = await workspace();
    await expect(runTrials({
      command: fixtureCommand('pass'), repeat: 3, cwd,
      onTrialComplete: () => { throw new Error('observer failed'); },
    })).rejects.toThrow(/observer failed/);
    const runIds = await readdir(join(cwd, '.failtrace', 'runs'));
    expect(runIds).toHaveLength(1);
    const directory = join(cwd, '.failtrace', 'runs', runIds[0]!);
    const metadata = await readJson(join(directory, 'run.json')) as RunSummary;
    expect(metadata).toMatchObject({
      status: 'error', error: 'observer failed', requestedTrials: 3,
      statistics: { total: 1, passed: 1, failed: 0 },
    });
    expect(metadata.endedAt).not.toBeNull();
    expect(metadata.trials).toHaveLength(1);
    expect(await readJson(join(directory, metadata.trials[0]!.stdoutPath, '..', 'result.json'))).toEqual(metadata.trials[0]);
    expect(await readFile(join(directory, metadata.trials[0]!.stdoutPath), 'utf8')).toBe('success: 안녕하세요\n');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid repeat %s before creating artifacts', async (repeat) => {
    const cwd = await workspace();
    await expect(runTrials({ command: fixtureCommand('pass'), repeat, cwd })).rejects.toThrow(/repeat/i);
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid timeout %s before creating artifacts', async (timeoutMs) => {
    const cwd = await workspace();
    await expect(runTrials({ command: fixtureCommand('pass'), timeoutMs, cwd })).rejects.toThrow(/timeout/i);
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each(['', '   ', '\n\t'])('rejects empty command %j', async (command) => {
    const cwd = await workspace();
    await expect(runTrials({ command, cwd })).rejects.toThrow(/command/i);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('keeps its API defaults usable with no repeat or timeout provided', async () => {
    const summary = await runTrials({ command: fixtureCommand('alternate'), cwd: await workspace() } satisfies RunOptions);
    expect(summary.requestedTrials).toBe(10);
    expect(summary.timeoutMs).toBe(30_000);
    expect(summary.statistics).toMatchObject({ total: 10, passed: 5, failed: 5 });
  }, 10_000);
});

describe('runTrial', () => {
  it('refuses to reuse a trial directory and preserves its existing output', async () => {
    const runDirectory = await workspace();
    const options = {
      index: 1, command: fixtureCommand('pass'), timeoutMs: 3_000,
      cwd: runDirectory, runDirectory,
    };
    const first = await runTrial(options);
    await expect(runTrial({ ...options, command: fixtureCommand('fail') })).rejects.toThrow();
    expect(await readFile(join(runDirectory, first.stdoutPath), 'utf8')).toBe('success: 안녕하세요\n');
    expect(await readFile(join(runDirectory, first.stderrPath), 'utf8')).toBe('diagnostic output\n');
  });

  it('returns a spawn error as data when the child cannot start', async () => {
    const runDirectory = await workspace();
    const result = await runTrial({
      index: 1, command: fixtureCommand('pass'), timeoutMs: 1_000,
      cwd: join(runDirectory, 'missing working directory'), runDirectory,
    });
    expect(result).toMatchObject({
      status: 'spawn_error', spawningFailed: true, timedOut: false,
      exitCode: null, terminationReason: 'spawn_error',
    });
    expect(result.error).toBeTruthy();
    expect(await readFile(join(runDirectory, result.stdoutPath), 'utf8')).toBe('');
    expect(await readFile(join(runDirectory, result.stderrPath), 'utf8')).toBeDefined();
  });
});

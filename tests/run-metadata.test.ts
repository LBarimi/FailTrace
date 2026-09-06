import { execFile } from 'node:child_process';
import { Dir, type Dirent } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTrials } from '../src/core/run-trials.js';
import { loadRun } from '../src/core/run-reader.js';
import { EMBEDDED_TRIALS_LIMIT, writeRunSummary } from '../src/core/run-metadata.js';
import { MAX_RECORDED_TRIALS } from '../src/core/metadata-budget.js';
import { writeJsonAtomic } from '../src/core/artifacts.js';
import { aggregateStatistics } from '../src/core/statistics.js';
import { cleanupDirectories, fixtureCommand, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const directories: string[] = [];
async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}
afterEach(async () => { vi.restoreAllMocks(); await cleanupDirectories(directories); });

describe('durable individual trial records', () => {
  it('recovers a durable trial after the host exits without writing a terminal summary', async () => {
    const cwd = await workspace();
    const coreUrl = new URL('../dist/core/index.js', import.meta.url).href;
    const script = join(cwd, 'crash.mjs');
    await writeFile(script, `import { runTrials } from ${JSON.stringify(coreUrl)};
await runTrials({ command: ${JSON.stringify(fixtureCommand('pass'))}, repeat: 10,
  cwd: ${JSON.stringify(cwd)}, onTrialComplete: () => process.exit(77) });\n`);
    await expect(execute(process.execPath, [script], { windowsHide: true })).rejects.toMatchObject({ code: 77 });
    const [id] = await readdir(join(cwd, '.failtrace', 'runs'));
    const directory = join(cwd, '.failtrace', 'runs', id!);
    const raw = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
    expect(raw).toMatchObject({ schemaVersion: 2, status: 'running', trialStorage: 'individual', trials: [] });
    // Unfinished output survives but must not be invented as a completed trial.
    await mkdir(join(directory, 'trials', '002'));
    await writeFile(join(directory, 'trials', '002', 'stdout.txt'), 'partial output');
    const recovered = await loadRun(directory);
    expect(recovered).toMatchObject({ status: 'running', endedAt: null,
      requestedTrials: 10, statistics: { total: 1, passed: 1 } });
    expect(recovered.trials.map(({ index }) => index)).toEqual([1]);
    expect(recovered).not.toHaveProperty('trialStorage');
  });

  it('stores large final summaries compactly, reloads exactly, and detects missing records', async () => {
    const run = await runTrials({ command: fixtureCommand('pass'), cwd: await workspace(), repeat: 3 });
    // Simulate large target/predicate diagnostics without spawning verbose children.
    for (const trial of run.trials) {
      trial.error = 'x'.repeat(400_000);
      await writeJsonAtomic(join(run.artifactDirectory, `trials/${String(trial.index).padStart(3, '0')}/result.json`), trial);
    }
    expect(Buffer.byteLength(JSON.stringify(run))).toBeGreaterThan(EMBEDDED_TRIALS_LIMIT);
    await writeRunSummary(run);
    expect((await stat(join(run.artifactDirectory, 'run.json'))).size).toBeLessThan(10_000);
    const raw = JSON.parse(await readFile(join(run.artifactDirectory, 'run.json'), 'utf8'));
    expect(raw).toMatchObject({ schemaVersion: 2, trialStorage: 'individual', trialCount: 3, trials: [] });
    expect(await loadRun(run.artifactDirectory)).toEqual({
      ...run, artifactDirectory: await realpath(run.artifactDirectory),
    });
    await rm(join(run.artifactDirectory, 'trials', '002', 'result.json'));
    await expect(loadRun(run.artifactDirectory)).rejects.toThrow();
    // A metadata write error must not prevent access to other durable records.
    run.status = 'error';
    run.error = 'Trial metadata write failed';
    await writeRunSummary(run);
    const recovered = await loadRun(run.artifactDirectory);
    expect(recovered).toMatchObject({ status: 'error', error: run.error, statistics: { total: 2 } });
    expect(recovered.trials.map(({ index }) => index)).toEqual([1, 3]);
  });

  it('rejects redirected trial directories and mismatched result indices during recovery', async () => {
    const cwd = await workspace();
    const run = await runTrials({ command: fixtureCommand('pass'), cwd, repeat: 1 });
    run.status = 'running';
    run.endedAt = null;
    await writeRunSummary(run);
    const outside = await workspace();
    await symlink(outside, join(run.artifactDirectory, 'trials', '002'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(loadRun(run.artifactDirectory)).rejects.toThrow(/directory/);
    await rm(join(run.artifactDirectory, 'trials', '002'));
    const trialPath = join(run.artifactDirectory, 'trials', '001', 'result.json');
    await writeJsonAtomic(trialPath, { ...run.trials[0], index: 2 });
    await expect(loadRun(run.artifactDirectory)).rejects.toThrow(/directory/);
  });

  it.each(['running', 'completed'] as const)('recomputes statistics from authoritative %s records', async (status) => {
    const run = await runTrials({ command: fixtureCommand('alternate'), cwd: await workspace(), repeat: 4 });
    run.status = status;
    if (status === 'running') run.endedAt = null;
    const expected = aggregateStatistics(run.trials);
    run.statistics = aggregateStatistics([]);
    await writeRunSummary(run);
    expect((await loadRun(run.artifactDirectory)).statistics).toEqual(expected);
  });

  it('counts ignored filenames against the saved trial traversal limit', async () => {
    const run = await runTrials({ command: fixtureCommand('pass'), cwd: await workspace(), repeat: 1 });
    run.status = 'running'; run.endedAt = null;
    await writeRunSummary(run);
    let yielded = 0;
    // Model a directory containing unrelated files without allocating 100001
    // real files merely to exercise the I/O enumeration allowance.
    vi.spyOn(Dir.prototype, Symbol.asyncIterator).mockImplementation(async function* (this: Dir) {
      try {
        for (let index = 0; index < MAX_RECORDED_TRIALS + 2; index++) {
          yielded++;
          yield { name: `unrelated-${index}` } as Dirent;
        }
      } finally { await this.close(); }
    });
    await expect(loadRun(run.artifactDirectory)).rejects.toThrow('100000 trial directory-entry');
    expect(yielded).toBe(MAX_RECORDED_TRIALS + 1);
  });

  it.each([42, ['ok', null], 'shell-like arguments'])('rejects malformed saved execution arguments %j', async args => {
    const run = await runTrials({ command: fixtureCommand('pass'), cwd: await workspace(), repeat: 1 });
    const path = join(run.artifactDirectory, 'run.json');
    await writeFile(path, JSON.stringify({ ...run, args }));
    await expect(loadRun(path)).rejects.toThrow(/arguments/i);
    await writeFile(path, JSON.stringify({ ...run, trials: [{ ...run.trials[0], args }] }));
    await expect(loadRun(path)).rejects.toThrow(/arguments/i);
  });

  it('rejects aggregate reconstruction beyond the allowance even when every file fits the per-document limit', async () => {
    const run = await runTrials({ command: fixtureCommand('pass'), cwd: await workspace(), repeat: 4 });
    // Older producers could retain arbitrary diagnostics. Each record is below
    // 32 MiB; four together exceed the new 96 MiB reconstruction allowance.
    const diagnostic = 'x'.repeat(25 * 1024 * 1024);
    for (const trial of run.trials) {
      await writeJsonAtomic(join(run.artifactDirectory, `trials/${String(trial.index).padStart(3, '0')}/result.json`),
        { ...trial, error: diagnostic });
    }
    run.status = 'running';
    run.endedAt = null;
    await writeRunSummary(run);
    await expect(loadRun(run.artifactDirectory)).rejects.toThrow('96 MiB aggregate limit');
  }, 30_000);

  it('bounds stored counts but still reads an older unfinished run with a larger requested schedule', async () => {
    const run = await runTrials({ command: fixtureCommand('pass'), cwd: await workspace(), repeat: 1 });
    run.status = 'running';
    run.endedAt = null;
    run.requestedTrials = MAX_RECORDED_TRIALS + 1;
    await writeRunSummary(run);
    expect((await loadRun(run.artifactDirectory)).trials).toHaveLength(1);
    const file = join(run.artifactDirectory, 'run.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeJsonAtomic(file, { ...stored, trialCount: MAX_RECORDED_TRIALS + 1 });
    await expect(loadRun(file)).rejects.toThrow('100000 recorded trial');
  });
});

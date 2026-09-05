import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessBaselineEligibility, assessRun, loadRun, minimizeFailure, runTrials } from '../src/core/index.js';
import { writeTextAtomic } from '../src/core/artifacts.js';
import { diagnosticMessage, MAX_COMMAND_BYTES, MAX_CONCURRENCY, MAX_EVALUATIONS,
  MAX_METADATA_BYTES, MAX_RECORDED_TRIALS, MetadataBudget, MetadataLimitError, trialMetadataAllowance } from '../src/core/metadata-budget.js';
import { OutputBudget } from '../src/core/output-budget.js';
import { runTrialsWithBudget } from '../src/core/run-trials.js';
import { cleanupDirectories, fixtureCommand, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
async function workspace(): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  return cwd;
}
afterEach(async () => { vi.restoreAllMocks(); await cleanupDirectories(directories); });

describe('bounded experiment metadata', () => {
  it('preserves the original reproducing input when the next minimization cannot reserve metadata', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'input.txt'), 'BUG extra text');
    const details = { limitBytes: MAX_METADATA_BYTES, usedBytes: 1, reservedBytes: 0, requiredBytes: MAX_METADATA_BYTES };
    const result = await minimizeFailure({ cwd, input: 'input.txt', format: 'text', command: fixtureCommand('fail'),
      onCandidate: () => {
        vi.spyOn(MetadataBudget.prototype, 'reserve').mockImplementationOnce(() => { throw new MetadataLimitError(details); });
      },
    });
    expect(result).toMatchObject({ status: 'limit_reached', finalVerified: false, metadataLimit: details });
    expect(result.evaluations).toHaveLength(1);
    expect(result.baseline?.assessment).toBe('reproduced');
    expect(result.final).toBeUndefined();
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('BUG extra text');
    expect(await readFile(join(cwd, 'input.txt'), 'utf8')).toBe('BUG extra text');
  });

  it('stops before an unrecordable trial and preserves both the observations and terminal checkpoint', async () => {
    const command = fixtureCommand('pass');
    const limitBytes = MAX_METADATA_BYTES + trialMetadataAllowance(command) + 1;
    const run = await runTrialsWithBudget({ cwd: await workspace(), command, repeat: 5 },
      new OutputBudget(1024), new MetadataBudget(limitBytes));
    expect(run.status).toBe('resource_limited');
    expect(run.trials).toHaveLength(1);
    expect(run.statistics).toMatchObject({ total: 1, passed: 1 });
    expect(run.metadataLimit).toMatchObject({ limitBytes, requiredBytes: trialMetadataAllowance(command) });
    expect(run.decision).toBeUndefined();
    expect(assessRun(run)).toBe('inconclusive');
    expect(assessBaselineEligibility({ ...run, status: 'completed', requestedTrials: 1 }).reasons)
      .toContain('Run exceeded its metadata allowance; the preselected sample is incomplete.');
    expect(await readdir(join(run.artifactDirectory, 'trials'))).toEqual(['001']);
    expect(await loadRun(run.artifactDirectory)).toEqual({ ...run, artifactDirectory: await realpath(run.artifactDirectory) });
    const storedBytes = (await stat(join(run.artifactDirectory, 'run.json'))).size
      + (await stat(join(run.artifactDirectory, 'trials', '001', 'result.json'))).size;
    expect(storedBytes).toBeLessThanOrEqual(limitBytes);
  });

  it('reserves trial storage before concurrent execution and lets already reserved trials finish', async () => {
    const command = fixtureCommand('pass');
    const run = await runTrialsWithBudget({ cwd: await workspace(), command, repeat: 6, concurrency: 3 },
      new OutputBudget(1024), new MetadataBudget(MAX_METADATA_BYTES + 2 * trialMetadataAllowance(command)));
    expect(run.status).toBe('resource_limited');
    expect(run.trials.map((trial) => trial.index)).toEqual([1, 2]);
    expect(run.trials.every((trial) => trial.status === 'passed')).toBe(true);
    expect(assessRun(run)).toBe('inconclusive');
    expect(await loadRun(run.artifactDirectory)).toEqual({ ...run, artifactDirectory: await realpath(run.artifactDirectory) });
  });

  it('charges saved records across candidate runs and returns unused header headroom', async () => {
    const command = fixtureCommand('pass');
    const metadata = new MetadataBudget(MAX_METADATA_BYTES + trialMetadataAllowance(command) + 1);
    const output = new OutputBudget(1024);
    const options = { cwd: await workspace(), command, repeat: 1 };
    const first = await runTrialsWithBudget(options, output, metadata);
    expect(first.status).toBe('completed');
    const next = await runTrialsWithBudget(options, output, metadata);
    expect(next.status).toBe('resource_limited');
    expect(next.trials).toEqual([]);
    expect(next.metadataLimit?.usedBytes).toBeGreaterThan(0);
    await expect(stat(join(next.artifactDirectory, 'trials'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await loadRun(next.artifactDirectory)).toEqual({ ...next, artifactDirectory: await realpath(next.artifactDirectory) });
    expect((await loadRun(first.artifactDirectory)).trials).toHaveLength(1);
  });

  it('rejects excessive schedules and commands before creating artifacts', async () => {
    const cwd = await workspace();
    const command = fixtureCommand('pass');
    await expect(runTrials({ cwd, command, repeat: MAX_RECORDED_TRIALS + 1 })).rejects.toThrow('100000');
    await expect(runTrials({ cwd, command, concurrency: MAX_CONCURRENCY + 1 })).rejects.toThrow('64');
    await expect(runTrials({ cwd, command: 'x'.repeat(MAX_COMMAND_BYTES + 1) })).rejects.toThrow('64 KiB');
    await expect(runTrials({ cwd, command: '€'.repeat(Math.floor(MAX_COMMAND_BYTES / 3) + 1) })).rejects.toThrow('64 KiB');
    await expect(minimizeFailure({ cwd, command, input: 'unused', format: 'text', maxEvaluations: MAX_EVALUATIONS + 1 }))
      .rejects.toThrow('10000');
    expect(await readdir(cwd)).toEqual([]);
  });

  it('refuses an oversized metadata replacement without touching the previous document', async () => {
    const cwd = await workspace();
    const file = join(cwd, 'report.json');
    await writeFile(file, '{"preserved":true}\n');
    await expect(writeTextAtomic(file, 'x'.repeat(MAX_METADATA_BYTES + 1))).rejects.toThrow('32 MiB');
    expect(await readFile(file, 'utf8')).toBe('{"preserved":true}\n');
    expect(await readdir(cwd)).toEqual(['report.json']);
  });

  it('bounds escaped diagnostics while leaving room for the complete command and trial fields', () => {
    const command = '\u0001'.repeat(MAX_COMMAND_BYTES);
    const diagnostic = diagnosticMessage(new Error('\u0002'.repeat(100_000)));
    expect(diagnostic.length).toBeLessThanOrEqual(2048);
    expect(diagnostic).toContain('[diagnostic truncated]');
    expect(Buffer.byteLength(JSON.stringify({ command, error: diagnostic })))
      .toBeLessThan(trialMetadataAllowance(command) - 1024);
  });
});

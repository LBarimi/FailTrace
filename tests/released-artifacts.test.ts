import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessBaselineEligibility, assessRun, compareRuns, createBundle, DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_TOTAL_OUTPUT_BYTES, inspectRunEvidence, loadRun, verifyFix,
} from '../src/core/index.js';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const fixtures = fileURLToPath(new URL('./fixtures/released-runs/', import.meta.url));
const versions = ['0.3.1', '0.4.0', '0.5.0', '0.6.0'];
const directories: string[] = [];
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => cleanupDirectories(directories));

async function relocatedBaseline(version: string): Promise<{ cwd: string; baseline: string }> {
  const temporary = await temporaryDirectory();
  directories.push(temporary);
  const cwd = await realpath(temporary);
  const baseline = join(cwd, 'baseline');
  await cp(join(fixtures, `${version}-completed`), baseline, { recursive: true });
  await cp(join(fixtures, 'target.mjs'), join(cwd, 'target.mjs'));
  const path = join(baseline, 'run.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  // Bind only the sanitized fixture's source locators to this test workspace.
  // Preserve old settings, environment, file hashes and evidence semantics.
  stored.cwd = cwd;
  if (stored.context) stored.context.workingDirectory = cwd;
  await writeFile(path, JSON.stringify(stored));
  return { cwd, baseline };
}

describe('records produced by released FailTrace packages', () => {
  it.each(versions)('reads, compares and pages a real %s completed record without upgrading its evidence', async (version) => {
    const directory = join(fixtures, `${version}-completed`);
    const header = await readFile(join(directory, 'run.json'));
    const run = await loadRun(directory);
    expect(run).toMatchObject({
      schemaVersion: 1, failtraceVersion: version, status: 'completed',
      cwd: '/fixture/workspace', artifactDirectory: await realpath(directory),
      requestedTrials: 2, statistics: { total: 2, passed: 1, failed: 1, failureRate: 0.5 },
      predicate: { kind: 'stderr_contains', value: 'COMPAT_TARGET' },
    });
    expect(run.trials.map(({ index, exitCode, failureMatched }) => ({ index, exitCode, failureMatched })))
      .toEqual([{ index: 1, exitCode: 0, failureMatched: false }, { index: 2, exitCode: 7, failureMatched: true }]);
    expect(run).not.toHaveProperty('maxOutputBytes');
    expect(run).not.toHaveProperty('maxTotalOutputBytes');
    if (version === '0.3.1') expect(run).not.toHaveProperty('concurrency');
    expect(assessRun(run)).toBe('reproduced');

    const comparison = await compareRuns({ runA: directory });
    expect(comparison).toMatchObject({ trialA: 1, trialB: 2, commandChanged: false, predicateChanged: false });
    expect(comparison.stdout).toMatchObject({
      equal: false, sha256A: sha256('trial 1\n'), sha256B: sha256('trial 2\n'), bytesA: 8, bytesB: 8,
    });
    expect(comparison.stderr).toMatchObject({ equal: false, sha256A: sha256(''), sha256B: sha256('COMPAT_TARGET\n') });
    const page = await inspectRunEvidence({ view: 'trials', run: directory, filter: 'matched', limit: 1 });
    if (page.view !== 'trials') throw new Error('Expected a trial page.');
    expect(page).toMatchObject({ recordedTrials: 2, matchedTrials: 1, nextAfterTrial: null });
    expect(page.trials.map((trial) => trial.index)).toEqual([2]);
    expect(await inspectRunEvidence({ view: 'output', run: directory, trial: 2, stream: 'stderr', maxBytes: 7 }))
      .toMatchObject({ text: 'COMPAT_', bytesRead: 7, nextOffsetBytes: 7, truncated: true });

    const eligibility = assessBaselineEligibility(run);
    expect(eligibility.eligible).toBe(version === '0.5.0' || version === '0.6.0');
    if (!eligibility.eligible) expect(eligibility.reasons.join(' ')).toContain('capture a fresh baseline');
    expect(await readFile(join(directory, 'run.json'))).toEqual(header);
  });

  it.each(versions.slice(1))('recovers %s individual records after host exit without declaring success', async (version) => {
    const directory = join(fixtures, `${version}-host-exit`);
    const header = await readFile(join(directory, 'run.json'));
    expect(JSON.parse(header.toString('utf8'))).toMatchObject({ schemaVersion: 2, trialStorage: 'individual', trials: [] });
    const run = await loadRun(directory);
    expect(run).toMatchObject({ schemaVersion: 1, status: 'running', endedAt: null,
      requestedTrials: 2, statistics: { total: 1, passed: 1, failed: 0 } });
    expect(run.trials.map((trial) => trial.index)).toEqual([1]);
    expect(run).not.toHaveProperty('trialStorage');
    expect(assessRun(run)).toBe('inconclusive');
    expect(assessBaselineEligibility(run).eligible).toBe(false);
    expect(await inspectRunEvidence({ view: 'trials', run: directory }))
      .toMatchObject({ status: 'running', recordedTrials: 1, matchedTrials: 0 });
    expect(await readFile(join(directory, 'run.json'))).toEqual(header);
  });

  it('retains the exact target bytes identified by the released context captures', async () => {
    const target = await readFile(join(fixtures, 'target.mjs'));
    const provenance: { targetSha256: string }[] = JSON.parse(await readFile(join(fixtures, 'provenance.json'), 'utf8'));
    for (const entry of provenance) expect(entry.targetSha256).toBe(sha256(target));
    for (const version of ['0.5.0', '0.6.0']) {
      const run = await loadRun(join(fixtures, `${version}-completed`));
      const expected = [{ path: 'target.mjs', bytes: target.length, sha256: sha256(target) }];
      expect(run.context?.before.sourceFiles).toEqual(expected);
      expect(run.context?.after?.sourceFiles).toEqual(expected);
    }
  });

  it.each(['0.5.0', '0.6.0'])('requires declared output-limit migration before verifying a %s baseline', async (version) => {
    const { cwd, baseline } = await relocatedBaseline(version);
    const options = { cwd, baseline, command: 'node target.mjs', env: { FAILTRACE_COMPAT_MODE: 'fixture' } };
    const blocked = await verifyFix(options);
    expect(blocked.status).toBe('inconclusive');
    expect(blocked.candidate).toBeNull();
    expect(blocked.changes).toContainEqual({ field: 'outputLimits', allowed: false,
      before: { maxOutputBytes: null, maxTotalOutputBytes: null },
      after: { maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, maxTotalOutputBytes: DEFAULT_MAX_TOTAL_OUTPUT_BYTES } });
    const permitted = await verifyFix({ ...options, allowChanges: [
      { field: 'outputLimits', reason: 'Use finite output budgets when migrating released evidence.' },
      { field: 'environment', reason: 'Replay the captured fixture on the current test host.' },
    ] });
    expect(permitted.status).toBe('target_observed');
    expect(permitted.candidate).toMatchObject({ completedTrials: 2, matchedTrials: 1, unhealthyTrials: 0 });
  });

  it.each(['0.3.1', '0.6.0'])('creates and replays a new bounded bundle from %s evidence', async (version) => {
    const { cwd, baseline } = await relocatedBaseline(version);
    const bundle = await createBundle({ cwd, run: baseline, files: ['target.mjs'], includeEnv: ['FAILTRACE_COMPAT_MODE'] });
    const config = JSON.parse(await readFile(bundle.configPath, 'utf8'));
    expect(config).toMatchObject({ schemaVersion: 2, command: 'node target.mjs', repeat: 2, concurrency: 1,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, maxTotalOutputBytes: DEFAULT_MAX_TOTAL_OUTPUT_BYTES,
      environment: { FAILTRACE_COMPAT_MODE: 'fixture' }, evidenceIncluded: false });
    await expect(execute(process.execPath, [join(bundle.directory, 'repro.mjs')], { cwd, windowsHide: true, timeout: 15_000 }))
      .rejects.toMatchObject({ code: 1 });
    const [id] = await readdir(join(bundle.directory, 'replay-artifacts/runs'));
    expect(id).toBeDefined();
    const replay = await loadRun(join(bundle.directory, 'replay-artifacts/runs', id!));
    expect(replay.statistics).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(assessRun(replay)).toBe('reproduced');
  });
});

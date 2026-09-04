import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assessBaselineEligibility, loadRun, runTrials, verifyFix } from '../src/core/index.js';
import { writeRunSummary } from '../src/core/run-metadata.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory } from './helpers.js';
import type { RunOptions, VerifyOptions } from '../src/core/index.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
const command = `${quoteShellArgument(process.execPath)} check.mjs`;
const declaration = { inputFiles: ['input.txt'], setupFiles: ['setup.json'], sourceFiles: ['check.mjs', 'release.json'] };
async function workspace(): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  await copyFile(fileURLToPath(new URL('./fixtures/verify-command.mjs', import.meta.url)), join(cwd, 'check.mjs'));
  await writeFile(join(cwd, 'input.txt'), 'unchanged input\n');
  await writeFile(join(cwd, 'setup.json'), '{"dependency":"pinned"}\n');
  await release(cwd, 'bug');
  return cwd;
}
async function release(cwd: string, mode: string): Promise<void> {
  await writeFile(join(cwd, 'release.json'), JSON.stringify({ mode }));
}
async function baseline(cwd: string, options: Partial<RunOptions> = {}) {
  return runTrials({ command, cwd, repeat: 3, predicate: { kind: 'stderr_contains', value: 'TARGET_VERIFY_FAILURE' },
    captureContext: declaration, ...options });
}
const intervention = [{ field: 'source' as const, reason: 'Apply the proposed source fix.' }];

describe('fixed-budget fix verification', () => {
  it('preserves a reproducing baseline, full successful candidate, identities and durable report', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    expect(assessBaselineEligibility(before)).toEqual({ eligible: true, reasons: [] });
    await release(cwd, 'fixed');
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command, repeat: 4, allowChanges: intervention });
    expect(result.status).toBe('target_not_observed');
    expect(result.baseline).toMatchObject({ requestedTrials: 3, completedTrials: 3, matchedTrials: 3, unhealthyTrials: 0 });
    expect(result.candidate).toMatchObject({ requestedTrials: 4, completedTrials: 4, matchedTrials: 0, healthyTrials: 4, unhealthyTrials: 0 });
    expect(result.changes).toMatchObject([{ field: 'source', allowed: true, reason: intervention[0]!.reason }]);
    expect(result.plan.repeat).toBe(4);
    expect(result.baseline?.context?.before.sourceFiles).not.toEqual(result.candidate?.context?.before.sourceFiles);
    expect(JSON.parse(await readFile(result.metadataPath, 'utf8'))).toEqual(result);
    const candidate = await loadRun(result.candidate!.metadataPath);
    expect(candidate.decision).toBeUndefined();
    expect(candidate.predicate).toEqual(before.predicate);
    expect(candidate.context?.stable).toBe(true);
  });

  it('reports an unchanged bug and a rare remaining failure without early stopping', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    const unchanged = await verifyFix({ baseline: before.artifactDirectory, cwd, command });
    expect(unchanged.status).toBe('target_observed');
    expect(unchanged.candidate).toMatchObject({ completedTrials: 3, matchedTrials: 3 });
    await release(cwd, 'rare');
    const candidate = await verifyFix({ baseline: before.artifactDirectory, cwd, command, allowChanges: intervention, repeat: 4 });
    expect(candidate.status).toBe('target_observed');
    expect(candidate.candidate).toMatchObject({ completedTrials: 4, matchedTrials: 1, unhealthyTrials: 0 });
  });

  it('refuses unrelated nonmatching failures even though run classifies them passed', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    await release(cwd, 'unrelated');
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command, allowChanges: intervention });
    expect(result.status).toBe('inconclusive');
    expect(result.candidate).toMatchObject({ matchedTrials: 0, completedTrials: 3, unhealthyTrials: 3,
      unrelatedFailureTrials: 3, infrastructureTrials: 0, invalidEvidenceTrials: 0 });
    expect((await loadRun(result.candidate!.metadataPath)).trials.every((trial) => trial.status === 'passed' && trial.exitCode === 1)).toBe(true);
  });

  it('accepts a deliberately declared healthy alternate exit policy', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    await release(cwd, 'alternate');
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command, allowChanges: intervention, healthyExitCodes: [0, 7] });
    expect(result.status).toBe('target_not_observed');
    expect(result.healthyExitCodes).toEqual([0, 7]);
  });

  it.each(['source', 'inputs', 'setup'] as const)('refuses unapproved %s drift before executing any candidate', async (field) => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    await writeFile(join(cwd, field === 'source' ? 'release.json' : field === 'inputs' ? 'input.txt' : 'setup.json'), field === 'source' ? '{"mode":"fixed"}' : 'changed');
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command });
    expect(result.status).toBe('inconclusive');
    expect(result.candidate).toBeNull();
    expect(result.changes).toMatchObject([{ field, allowed: false }]);
  });

  it('records timeout, concurrency, command and selected environment drift', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd, { captureEnv: ['FAILTRACE_VERIFY_ENV'], env: { FAILTRACE_VERIFY_ENV: 'before' } });
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command: `${command} unused`, timeoutMs: 999, concurrency: 2,
      env: { FAILTRACE_VERIFY_ENV: 'after' } });
    expect(result.status).toBe('inconclusive');
    expect(result.candidate).toBeNull();
    expect(result.changes.map((change) => change.field)).toEqual(['command', 'timeout', 'concurrency', 'environment']);
    expect(result.plan.captureEnv).toEqual(['FAILTRACE_VERIFY_ENV']);
  });

  it('does not confuse missing selected values with unknown legacy environment', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd, { captureEnv: ['FAILTRACE_VERIFY_ENV'], env: { FAILTRACE_VERIFY_ENV: undefined } });
    expect(before.environment?.variables).toEqual({ FAILTRACE_VERIFY_ENV: null });
    delete before.environment;
    await writeRunSummary(before);
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command });
    expect(result.baselineEligibility.eligible).toBe(false);
    expect(result.candidate).toBeNull();
  });

  it.each(['no-context', 'no-match', 'unknown-match', 'threshold', 'partial', 'missing-output'] as const)('rejects %s baselines without executing', async (kind) => {
    const cwd = await workspace();
    if (kind === 'no-match') await release(cwd, 'fixed');
    const before = await baseline(cwd, kind === 'threshold' ? { stopWhenDecided: { minFailures: 1 } } : {});
    if (kind === 'no-context') delete before.context;
    if (kind === 'unknown-match') delete before.trials[0]!.failureMatched;
    if (kind === 'partial') before.trials.pop();
    if (kind === 'missing-output') await rm(join(before.artifactDirectory, before.trials[0]!.stdoutPath));
    await writeRunSummary(before);
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command });
    expect(result.status).toBe('inconclusive');
    expect(result.baselineEligibility.eligible).toBe(false);
    expect(result.candidate).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
    if (kind === 'unknown-match') expect(result.baseline?.invalidEvidenceTrials).toBe(1);
  });

  it('rejects context mutations during the baseline or candidate experiment', async () => {
    const cwd = await workspace();
    const unstable = await baseline(cwd, { onTrialComplete: async (trial) => {
      if (trial.index === 1) await writeFile(join(cwd, 'input.txt'), 'changed during baseline');
    } });
    expect(unstable.context?.stable).toBe(false);
    expect(assessBaselineEligibility(unstable).eligible).toBe(false);
    const before = await baseline(cwd);
    await release(cwd, 'fixed');
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command, allowChanges: intervention,
      onTrialComplete: async (trial) => { if (trial.index === 1) await writeFile(join(cwd, 'setup.json'), 'changed during candidate'); } });
    expect(result.status).toBe('inconclusive');
    expect(result.candidate?.context?.stable).toBe(false);
  });

  it('pins selected environment for all trials despite callback mutation', async () => {
    const cwd = await workspace();
    await release(cwd, 'environment');
    const overrides = { FAILTRACE_VERIFY_ENV: 'captured' };
    const run = await baseline(cwd, { captureEnv: ['FAILTRACE_VERIFY_ENV'], env: overrides, onTrialComplete: () => { overrides.FAILTRACE_VERIFY_ENV = 'changed'; } });
    expect(run.environment?.variables).toEqual({ FAILTRACE_VERIFY_ENV: 'captured' });
    for (const trial of run.trials) expect((await readFile(join(run.artifactDirectory, trial.stdoutPath), 'utf8')).trim()).toBe('captured');
  });

  it('preserves cancellation evidence and never counts unstarted trials as successful', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    await release(cwd, 'fixed');
    const controller = new AbortController();
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command, repeat: 5, allowChanges: intervention,
      signal: controller.signal, onTrialComplete: () => controller.abort() });
    expect(result.status).toBe('interrupted');
    expect(result.candidate).toMatchObject({ requestedTrials: 5, completedTrials: 1, matchedTrials: 0 });
    expect(JSON.parse(await readFile(result.metadataPath, 'utf8')).status).toBe('interrupted');
  });

  it('returns a durable interrupted report for a pre-aborted verification', async () => {
    const cwd = await workspace();
    const result = await verifyFix({ baseline: 'unused', cwd, command, signal: AbortSignal.abort() });
    expect(result.status).toBe('interrupted');
    expect(result.candidate).toBeNull();
    expect(JSON.parse(await readFile(result.metadataPath, 'utf8')).status).toBe('interrupted');
  });

  it('preserves error metadata when a callback fails', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command,
      onTrialComplete: () => { throw new Error('intentional observer failure'); } });
    expect(result.status).toBe('inconclusive');
    expect(result.candidate).toMatchObject({ completedTrials: 1, matchedTrials: 1 });
    expect((await loadRun(result.candidate!.metadataPath)).status).toBe('error');
  });

  it('refuses a different cwd rather than executing a saved experiment elsewhere', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    const other = await workspace();
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd: other, command, allowChanges: intervention });
    expect(result.status).toBe('inconclusive');
    expect(result.candidate).toBeNull();
    expect(result.reasons.join(' ')).toContain('working directory differs');
  });

  it('requires current execution authority and rejects invalid policies', async () => {
    const cwd = await workspace();
    const options = { baseline: 'unused', cwd, command };
    await expect(verifyFix({ ...options, command: '' })).rejects.toThrow('Command');
    await expect(verifyFix({ ...options, cwd: undefined } as unknown as VerifyOptions)).rejects.toThrow('explicit');
    await expect(verifyFix({ ...options, healthyExitCodes: [] })).rejects.toThrow('Healthy');
    await expect(verifyFix({ ...options, allowChanges: [{ field: 'source', reason: ' ' }] })).rejects.toThrow('Allowed');
  });

  it('records infrastructure timeout as inconclusive', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd, { repeat: 1 });
    await release(cwd, 'timeout');
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command, timeoutMs: 50,
      allowChanges: [...intervention, { field: 'timeout', reason: 'Bound this timeout control.' }] });
    expect(result.status).toBe('inconclusive');
    expect(result.candidate).toMatchObject({ completedTrials: 1, matchedTrials: 0, unhealthyTrials: 1,
      infrastructureTrials: 1, unrelatedFailureTrials: 0, invalidEvidenceTrials: 0 });
  });

  it('allows explicit sources in an ignored nested workspace without coupling unrelated parent files', async () => {
    const outer = await workspace();
    const cwd = join(outer, '.failtrace', 'case');
    await mkdir(cwd, { recursive: true });
    for (const path of ['check.mjs', 'release.json', 'input.txt', 'setup.json']) await copyFile(join(outer, path), join(cwd, path));
    const before = await baseline(cwd, { repeat: 1 });
    await writeFile(join(outer, 'unrelated.txt'), 'changed outside declared source scope');
    const result = await verifyFix({ baseline: before.artifactDirectory, cwd, command, repeat: 1 });
    expect(result.status).toBe('target_observed');
    expect(result.baseline?.context?.before.source.kind).toBe('files');
  });
});

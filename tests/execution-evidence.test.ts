import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { assessBaselineEligibility, assessRun, compareRuns, createBundle, inspectRunEvidence, loadRun, minimizeFailure,
  runTrials, validateRunOptions, verifyFix } from '../src/core/index.js';
import type { ExecutionRequirement, RunOptions } from '../src/core/index.js';
import { writeRunSummary } from '../src/core/run-metadata.js';
import { parseArgs } from '../src/cli/args.js';
import { cleanupDirectories, cliPath, quoteShellArgument, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const directories: string[] = [];
const fixtures = fileURLToPath(new URL('../examples/workflows/event-import/', import.meta.url));
const command = `${quoteShellArgument(process.execPath)} check.mjs`;
const requirement: ExecutionRequirement = { stream: 'stdout', contains: 'IMPORT_CHECK_COMPLETED' };
const declaration = { inputFiles: ['events.json'], sourceFiles: ['check.mjs', 'importer.mjs'] };
const intervention = [{ field: 'source' as const, reason: 'Apply the proposed change.' }];
afterEach(async () => cleanupDirectories(directories));

async function workspace() {
  const cwd = await temporaryDirectory(); directories.push(cwd);
  for (const file of ['check.mjs', 'importer.mjs', 'events.json']) await copyFile(join(fixtures, file), join(cwd, file));
  return cwd;
}
function baseline(cwd: string, extra: Partial<RunOptions> = {}) {
  return runTrials({ command, cwd, repeat: 2,
    predicate: { kind: 'stderr_contains', value: 'IMPORT_REVISION_LOST' },
    executionRequirement: requirement, captureContext: declaration, ...extra });
}
async function node(args: string[], cwd: string) {
  try { return { ...await execute(process.execPath, args, { cwd, windowsHide: true, timeout: 10_000 }), code: 0 }; }
  catch (error) { if (typeof (error as { code?: unknown }).code !== 'number') throw error;
    return error as { stdout: string; stderr: string; code: number }; }
}

describe('opt-in execution checkpoints', () => {
  it.each([null, {}, { stream: 'stdin', contains: 'done' }, { stream: 'stdout', contains: '' },
    { stream: 'stderr', contains: 'x'.repeat(1_048_577) }])('rejects an invalid requirement before execution (%#)', value => {
    expect(() => validateRunOptions({ command, executionRequirement: value as ExecutionRequirement })).toThrow('Execution requirement');
  });

  it.each(['stdout', 'stderr'] as const)('matches a UTF-8 checkpoint spanning stream chunks in %s', async stream => {
    const cwd = await workspace();
    const marker = 'done-é-終';
    await writeFile(join(cwd, 'check.mjs'), `process.${stream}.write('x'.repeat(65533) + ${JSON.stringify(marker)});`);
    const run = await runTrials({ command, cwd, repeat: 1, executionRequirement: { stream, contains: marker } });
    expect(run.trials[0]).toMatchObject({ executionMatched: true, failureMatched: false });
    expect(assessRun(await loadRun(run.artifactDirectory))).toBe('not_reproduced');
  });

  it('keeps legacy behavior opt-in and refuses threshold decisions when a requested checkpoint is absent', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'check.mjs'), 'console.error("IMPORT_REVISION_LOST"); process.exitCode = 7;');
    const legacy = await runTrials({ command, cwd, repeat: 1 });
    expect(legacy.executionRequirement).toBeUndefined();
    expect(legacy.trials[0]!.executionMatched).toBeUndefined();
    expect(assessRun(legacy)).toBe('reproduced');
    const required = await baseline(cwd, { repeat: 5, stopWhenDecided: { minFailures: 1 } });
    expect(required.trials).toHaveLength(1);
    expect(required.trials[0]).toMatchObject({ failureMatched: true, executionMatched: false, exitCode: 7 });
    expect(required.decision).toBeUndefined();
    expect(assessRun(required)).toBe('inconclusive');
  });

  it('does not accept a checkpoint from truncated output or a timed-out process', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'check.mjs'), 'console.log("IMPORT_CHECK_COMPLETED"); process.stdout.write("x".repeat(10000));');
    const limited = await baseline(cwd, { repeat: 1, maxOutputBytes: 40 });
    expect(limited.trials[0]).toMatchObject({ executionMatched: false, status: 'resource_limited' });
    expect(assessRun(limited)).toBe('inconclusive');
    await writeFile(join(cwd, 'check.mjs'), 'console.log("IMPORT_CHECK_COMPLETED"); setInterval(() => {}, 1000);');
    const timed = await baseline(cwd, { repeat: 1, timeoutMs: 700 });
    expect(timed.trials[0]).toMatchObject({ executionMatched: false, status: 'timed_out' });
    expect(assessRun(timed)).toBe('inconclusive');
  });

  it('pins the requirement against caller mutation and records it in each durable trial', async () => {
    const cwd = await workspace();
    const selected = { ...requirement };
    const run = await baseline(cwd, { executionRequirement: selected, onTrialComplete: () => { selected.contains = 'changed'; } });
    expect(run.executionRequirement).toEqual(requirement);
    expect((await loadRun(run.artifactDirectory)).trials.every(trial => trial.executionMatched === true)).toBe(true);
  });

  it.each(['fixed', 'skipped', 'unrelated'] as const)('inherits baseline evidence when the candidate is %s', async kind => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    expect(assessBaselineEligibility(before).eligible).toBe(true);
    if (kind === 'fixed') await copyFile(join(fixtures, 'importer-fixed.mjs'), join(cwd, 'importer.mjs'));
    else await writeFile(join(cwd, 'check.mjs'), kind === 'skipped' ? 'console.log("Check skipped.");' : 'console.error("SETUP_ERROR"); process.exitCode = 125;');
    const result = await verifyFix({ command, cwd, baseline: before.artifactDirectory, allowChanges: intervention });
    expect(result.plan.executionRequirement).toEqual(requirement);
    expect(result.status).toBe(kind === 'fixed' ? 'target_not_observed' : 'inconclusive');
    const candidate = await loadRun(result.candidate!.metadataPath);
    expect(candidate.executionRequirement).toEqual(requirement);
    expect(candidate.trials.every(trial => trial.executionMatched === (kind === 'fixed'))).toBe(true);
    if (kind === 'skipped') {
      expect(result.candidate).toMatchObject({ matchedTrials: 0, healthyTrials: 0, executionEvidenceMissingTrials: 2 });
      expect(result.reasons.join(' ')).toContain('checkpoint');
    }
  });

  it('treats absent recorded completion as unknown and validates saved metadata', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    delete before.trials[0]!.executionMatched;
    await writeRunSummary(before);
    expect(assessRun(await loadRun(before.artifactDirectory))).toBe('inconclusive');
    const inspected = await inspectRunEvidence({ view: 'trials', run: before.artifactDirectory, filter: 'unhealthy' });
    expect(inspected).toMatchObject({ executionRequirement: requirement, trials: [{ index: 1, executionMatched: null, unhealthy: true }] });
    const result = await verifyFix({ command, cwd, baseline: before.artifactDirectory });
    expect(result.candidate).toBeNull();
    expect(result.baselineEligibility.eligible).toBe(false);
    Object.assign(before.trials[0]!, { executionMatched: 'yes' });
    await writeRunSummary(before);
    await expect(loadRun(before.artifactDirectory)).rejects.toThrow('execution evidence');
    before.trials[0]!.executionMatched = true;
    Object.assign(before, { executionRequirement: { stream: 'stdin', contains: 'done' } });
    await writeRunSummary(before);
    await expect(loadRun(before.artifactDirectory)).rejects.toThrow('Execution requirement');
  });

  it('rechecks baseline output rather than trusting a claimed completion flag', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd);
    await writeFile(join(before.artifactDirectory, before.trials[0]!.stdoutPath), 'Checkpoint removed.');
    const result = await verifyFix({ command, cwd, baseline: before.artifactDirectory });
    expect(result.candidate).toBeNull();
    expect(result.reasons.join(' ')).toContain('saved output');
  });

  it('recovers checkpoint evidence from compact individual trial records without inventing missing fields', async () => {
    const cwd = await workspace();
    const run = await baseline(cwd);
    await writeFile(join(run.artifactDirectory, 'run.json'), JSON.stringify({ ...run,
      schemaVersion: 2, trialStorage: 'individual', trials: [], trialCount: 2,
    }));
    const recovered = await loadRun(run.artifactDirectory);
    expect(assessRun(recovered)).toBe('reproduced');
    expect(recovered.trials.every(trial => trial.executionMatched === true)).toBe(true);
    const record = join(run.artifactDirectory, 'trials', '001', 'result.json');
    const trial = JSON.parse(await readFile(record, 'utf8'));
    delete trial.executionMatched;
    await writeFile(record, JSON.stringify(trial));
    const unknown = await loadRun(run.artifactDirectory);
    expect(unknown.trials[0]!.executionMatched).toBeUndefined();
    expect(assessRun(unknown)).toBe('inconclusive');
  });

  it('selects a completed nonmatch for comparison and warns about an explicit skipped trial', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'check.mjs'), `const index = Number(process.env.FAILTRACE_TRIAL_INDEX);
      if (index > 1) console.log('IMPORT_CHECK_COMPLETED');
      if (index === 3) { console.error('IMPORT_REVISION_LOST'); process.exitCode = 7; }`);
    const run = await baseline(cwd, { repeat: 3 });
    const preferred = await compareRuns({ runA: run.artifactDirectory });
    expect(preferred).toMatchObject({ trialA: 2, trialB: 3, warnings: [] });
    const skipped = await compareRuns({ runA: run.artifactDirectory, trialA: 1 });
    expect(skipped.warnings?.join(' ')).toContain('checkpoint');
    expect(skipped.selectedTrials?.a.executionMatched).toBe(false);
  });

  it('preserves the checkpoint in bundle replay and refuses a skipped replay', async () => {
    const cwd = await workspace();
    const before = await baseline(cwd, { repeat: 1 });
    const bundle = await createBundle({ cwd, run: before.artifactDirectory, command: 'node check.mjs', files: ['check.mjs', 'importer.mjs', 'events.json'] });
    expect(JSON.parse(await readFile(bundle.configPath, 'utf8')).executionRequirement).toEqual(requirement);
    const reproduced = await node(['repro.mjs'], bundle.directory);
    expect(reproduced).toMatchObject({ code: 1, stderr: '' });
    expect(reproduced.stdout).toContain('Target failure reproduced: 1 / 1');
    await writeFile(join(bundle.directory, 'source', 'check.mjs'), 'console.log("Skipped");');
    const replay = await node(['repro.mjs'], bundle.directory);
    expect(replay.code).toBe(2);
    expect(replay.stdout).toContain('Replay inconclusive');
  });

  it('does not minimize a target whose baseline lacks the required checkpoint', async () => {
    const cwd = await workspace();
    const missing = { stream: 'stderr' as const, contains: 'CHECK_NOT_EMITTED' };
    const result = await minimizeFailure({ command, cwd, input: 'events.json', format: 'json', executionRequirement: missing });
    expect(result).toMatchObject({ status: 'inconclusive', finalVerified: false, executionRequirement: missing });
    expect(result.evaluations.map(value => value.phase)).toEqual(['baseline', 'final']);
    expect((await loadRun(result.final!.runDirectory)).trials[0]?.executionMatched).toBe(false);
  });

  it('exposes the checkpoint in CLI parsing, JSON, exit status and terminal diagnostics', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'check.mjs'), 'console.log("Skipped");');
    const args = ['run', command, '--cwd', cwd, '--repeat', '1', '--require-stdout-contains', requirement.contains];
    expect(parseArgs(args)).toMatchObject({ executionRequirement: requirement });
    expect(() => parseArgs([...args, '--require-stderr-contains', 'done'])).toThrow('one execution');
    expect(() => parseArgs(['verify', 'baseline', '--command', command, '--cwd', cwd, '--require-stdout-contains', 'weakened'])).toThrow('Unexpected option');
    const text = await node([cliPath, ...args], cwd);
    expect(text.code).toBe(2);
    expect(text.stdout).toContain('Run inconclusive: required execution checkpoint missing');
    const json = await node([cliPath, ...args, '--json'], cwd);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ executionRequirement: requirement, trials: [{ executionMatched: false }] });
  });
});

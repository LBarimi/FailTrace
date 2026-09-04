import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, runTrials, loadRun, verifyFix, compareRuns, quote } from '../verify-engine.mjs';

const caseDirectory = dirname(fileURLToPath(import.meta.url));
const parent = join(caseDirectory, '.failtrace');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'verify-'));
const cwd = join(directory, 'target');
await mkdir(cwd);
const files = ['check.mjs', 'race.mjs', 'release.mjs', 'schedule.json', 'package.json', 'package-lock.json'];
for (const file of files) await copyFile(join(caseDirectory, file), join(cwd, file));
const originalSelection = await readFile(join(caseDirectory, 'release.mjs'), 'utf8');
const originalSchedule = await readFile(join(cwd, 'schedule.json'), 'utf8');
const command = `${quote(process.execPath)} check.mjs`;
const predicate = { kind: 'stderr_contains', value: 'P_MEMOIZE_DUPLICATE_IN_FLIGHT' };
const controller = new AbortController();
let interruptedBy;
const interrupt = kind => { interruptedBy ??= kind; controller.abort(); };
const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
const { signal } = controller;

try {
  const baseline = await runTrials({ command, cwd, repeat: 6, concurrency: 1, timeoutMs: 10_000, predicate, signal,
    captureContext: { inputFiles: ['schedule.json'], setupFiles: ['package.json', 'package-lock.json'],
      sourceFiles: ['check.mjs', 'race.mjs', 'release.mjs'] } });
  signal.throwIfAborted();
  assert.equal(baseline.trials.length, 6);
  assert.equal(baseline.trials.filter(trial => trial.failureMatched === true).length, 3);

  // Controls are sampled with the same full budget before the fixed version.
  const unchanged = await verifyFix({ baseline: baseline.artifactDirectory, command, cwd, signal });
  assert.equal(unchanged.status, 'target_observed');
  assert.equal(unchanged.candidate.matchedTrials, 3);
  signal.throwIfAborted();

  await writeFile(join(cwd, 'release.mjs'), `${originalSelection}// Attempted intervention still selects the affected version.\n`);
  const wrongFix = await verifyFix({ baseline: baseline.artifactDirectory, command, cwd, signal,
    allowChanges: [{ field: 'source', reason: 'Negative control: source changed without replacing the affected dependency.' }] });
  assert.equal(wrongFix.status, 'target_observed');
  assert.equal(wrongFix.candidate.matchedTrials, 3);
  signal.throwIfAborted();

  await writeFile(join(cwd, 'release.mjs'), "export const packageName = 'missing-package';\n");
  const setupError = await verifyFix({ baseline: baseline.artifactDirectory, command, cwd, signal,
    allowChanges: [{ field: 'source', reason: 'Negative control: an invalid dependency selection must not count as a fix.' }] });
  assert.equal(setupError.status, 'inconclusive');
  assert.equal(setupError.candidate.matchedTrials, 0);
  assert.equal(setupError.candidate.unhealthyTrials, 6);
  signal.throwIfAborted();

  await writeFile(join(cwd, 'release.mjs'), "export const packageName = 'memoize-fixed';\n");
  const verification = await verifyFix({ baseline: baseline.artifactDirectory, command, cwd, signal,
    allowChanges: [{ field: 'source', reason: 'Replace pinned p-memoize 6.0.2 with pinned 7.0.0 through release.mjs; all schedules and dependency manifests remain unchanged.' }] });
  signal.throwIfAborted();
  assert.equal(verification.status, 'target_not_observed');
  assert.equal(verification.candidate.completedTrials, 6);
  assert.equal(verification.candidate.matchedTrials, 0);
  assert.equal(verification.candidate.healthyTrials, 6);
  const candidate = await loadRun(verification.candidate.artifactDirectory);
  assert(candidate.trials.every(trial => trial.exitCode === 0 && trial.terminationReason === 'exit' && trial.error === undefined));
  const comparison = await compareRuns({ runA: baseline.artifactDirectory,
    runB: candidate.artifactDirectory, trialA: 1, trialB: 1, signal });
  assert.equal(comparison.commandChanged, false);
  assert.equal(comparison.stderr.equal, false);
  assert.equal(await readFile(join(cwd, 'schedule.json'), 'utf8'), originalSchedule);
  assert.equal(await readFile(join(caseDirectory, 'release.mjs'), 'utf8'), originalSelection);
  const report = { case: 'sindresorhus/p-memoize#43', upstream: 'https://github.com/sindresorhus/p-memoize/pull/48',
    failtraceVersion: VERSION, affectedVersion: '6.0.2', fixedVersion: '7.0.0',
    sampling: 'Six predeclared controlled interleavings: overlap, sequential, repeated three times. These are schedule-coverage outcomes, not a naturally sampled flaky-failure probability.',
    unchanged, wrongFix, setupError, verification, comparison };
  const reportPath = join(directory, 'case-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log('Affected: 3/6 schedule outcomes match; fixed: 0/6 matches and 6 healthy exits.');
  console.log('Controls: unchanged and wrong fix retain the race; setup failure is inconclusive.');
  console.log('The schedules were controlled; this does not estimate a natural failure probability.');
  console.log(`Verify status: ${verification.status}`);
  console.log(`Report: ${reportPath}`);
} catch (error) {
  process.exitCode = signal.aborted ? interruptedBy === 'SIGTERM' ? 143 : 130 : 2;
  console.error(signal.aborted ? 'Investigation interrupted; partial evidence remains in .failtrace.'
    : error instanceof Error ? error.message : String(error));
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

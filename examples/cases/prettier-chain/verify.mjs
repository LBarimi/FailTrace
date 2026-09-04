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
for (const file of ['check.mjs', 'fixture.ts', 'package.json', 'package-lock.json']) await copyFile(join(caseDirectory, file), join(cwd, file));
const fixture = await readFile(join(cwd, 'fixture.ts'), 'utf8');
await writeFile(join(cwd, 'release.mjs'), "export const selected = 'affected';\n", { flag: 'wx' });
await writeFile(join(cwd, 'entry.mjs'), "import { selected } from './release.mjs';\nprocess.argv.push(selected);\nawait import('./check.mjs');\n", { flag: 'wx' });
const command = `${quote(process.execPath)} entry.mjs`;
const predicate = { kind: 'stderr_contains', value: 'PRETTIER_NOT_IDEMPOTENT' };
const env = { FAILTRACE_INPUT: undefined, FAILTRACE_INPUT_DIR: undefined };
const controller = new AbortController();
let interruptedBy;
const interrupt = kind => { interruptedBy ??= kind; controller.abort(); };
const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
const { signal } = controller;

try {
  const baseline = await runTrials({ command, cwd, repeat: 3, concurrency: 1, timeoutMs: 10_000, predicate, env, signal,
    captureEnv: ['FAILTRACE_INPUT', 'FAILTRACE_INPUT_DIR'],
    captureContext: { inputFiles: ['fixture.ts'], setupFiles: ['package.json', 'package-lock.json'],
      sourceFiles: ['check.mjs', 'entry.mjs', 'release.mjs'] } });
  signal.throwIfAborted();
  assert.equal(baseline.trials.filter(trial => trial.failureMatched === true).length, 3);
  await writeFile(join(cwd, 'release.mjs'), "export const selected = 'fixed';\n");
  const verification = await verifyFix({ baseline: baseline.artifactDirectory, command, cwd, env, signal,
    allowChanges: [{ field: 'source', reason: 'Change release.mjs from pinned Prettier 3.0.3 to pinned 3.2.0; retain the same input, command, checker and dependency manifests.' }] });
  signal.throwIfAborted();
  assert.equal(verification.status, 'target_not_observed');
  assert.equal(verification.candidate.completedTrials, 3);
  assert.equal(verification.candidate.matchedTrials, 0);
  assert.equal(verification.candidate.healthyTrials, 3);
  const candidate = await loadRun(verification.candidate.artifactDirectory);
  assert(candidate.trials.every(trial => trial.exitCode === 0 && trial.terminationReason === 'exit' && trial.error === undefined));
  const comparison = await compareRuns({ runA: baseline.artifactDirectory,
    runB: candidate.artifactDirectory, trialA: 1, trialB: 1, signal });
  assert.equal(comparison.commandChanged, false);
  assert.equal(comparison.stderr.equal, false);
  assert.equal(await readFile(join(cwd, 'fixture.ts'), 'utf8'), fixture);
  assert.equal(await readFile(join(caseDirectory, 'fixture.ts'), 'utf8'), fixture);
  const reportPath = join(directory, 'case-report.json');
  await writeFile(reportPath, `${JSON.stringify({ case: 'prettier/prettier#15435',
    failtraceVersion: VERSION, affectedVersion: '3.0.3', fixedVersion: '3.2.0', verification, comparison }, null, 2)}\n`, { flag: 'wx' });
  console.log('Prettier: 3/3 affected matches; 0/3 candidate matches and 3 healthy exits.');
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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, runTrials, compareRuns, minimizeFailure, createBundle } from 'failtrace';

const cwd = dirname(fileURLToPath(import.meta.url));
const predicate = { kind: 'stderr_contains', value: 'PRETTIER_NOT_IDEMPOTENT' };
const quote = value => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
const command = `${quote(process.execPath)} check.mjs affected`;
const fixedCommand = `${quote(process.execPath)} check.mjs fixed`;
const count = run => run.trials.filter(trial => trial.failureMatched === true).length;
const cleanExit = (run, code) => {
  assert.equal(run.status, 'completed');
  for (const trial of run.trials) {
    assert.equal(trial.exitCode, code, 'A missing match is insufficient: check actual process exit status');
    assert.equal(trial.terminationReason, 'exit');
    assert.equal(trial.spawningFailed, false);
    assert.equal(trial.error, undefined);
  }
};
const controller = new AbortController();
const { signal } = controller;
let interruptedBy;
const interrupt = kind => {
  if (interruptedBy) return;
  interruptedBy = kind;
  controller.abort();
};
const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

try {
  const source = await readFile(join(cwd, 'fixture.ts'), 'utf8');
  assert.equal(VERSION, '0.3.0');
  signal.throwIfAborted();

  console.log('Checking the affected release and fixed control...');
  const affected = await runTrials({ command, cwd, repeat: 3, timeoutMs: 10_000, predicate, signal, env: { FAILTRACE_INPUT: undefined } });
  signal.throwIfAborted();
  const fixed = await runTrials({ command: fixedCommand, cwd, repeat: 3, timeoutMs: 10_000, predicate, signal, env: { FAILTRACE_INPUT: undefined } });
  signal.throwIfAborted();
  cleanExit(affected, 1);
  cleanExit(fixed, 0);
  assert.equal(count(affected), 3, 'The original input must reproduce the specific defect');
  assert.equal(fixed.statistics.passed, 3, 'The fixed release must actually succeed');
  assert.equal(count(fixed), 0);
  const comparison = await compareRuns({ runA: affected.artifactDirectory, runB: fixed.artifactDirectory, signal });
  signal.throwIfAborted();
  assert.equal(comparison.stderr.equal, false);

  console.log('Reducing the input while preserving the formatting mismatch...');
  const reduction = await minimizeFailure({ command, cwd, input: 'fixture.ts', format: 'text', predicate, signal,
    timeoutMs: 10_000, maxEvaluations: 250 });
  signal.throwIfAborted();
  assert.equal(reduction.status, 'completed', 'Inspect saved evidence if a budget or execution limit was reached');
  assert.equal(reduction.finalVerified, true);
  assert(reduction.final);
  assert(reduction.minimizedSize < reduction.originalSize);
  const minimized = await readFile(reduction.minimizedPath, 'utf8');
  signal.throwIfAborted();
  const fixedReduced = await runTrials({ command: fixedCommand, cwd, repeat: 1, timeoutMs: 10_000, predicate, signal,
    env: { FAILTRACE_INPUT: reduction.minimizedPath } });
  signal.throwIfAborted();
  cleanExit(fixedReduced, 0);
  assert.equal(fixedReduced.statistics.passed, 1, 'The reduced input must also succeed with the fixed release');
  assert.equal(count(fixedReduced), 0);

  const bundle = await createBundle({ run: reduction.final.runDirectory, cwd, signal,
    files: ['check.mjs', 'package.json', 'package-lock.json'], input: reduction.minimizedPath,
    command: 'node check.mjs affected' });
  signal.throwIfAborted();
  const report = {
    case: 'prettier/prettier#15435', upstream: 'https://github.com/prettier/prettier/issues/15435',
    failtraceVersion: VERSION, nodeVersion: process.version, platform: process.platform,
    affectedVersion: '3.0.3', fixedVersion: '3.2.0', predicate,
    fixtureSha256: createHash('sha256').update(source).digest('hex'),
    affected: { matches: count(affected), trials: affected.statistics.total, directory: affected.artifactDirectory },
    fixed: { matches: count(fixed), trials: fixed.statistics.total, directory: fixed.artifactDirectory },
    reduction: { status: reduction.status, originalCharacters: reduction.originalSize, minimizedCharacters: reduction.minimizedSize,
      minimizedInput: minimized, evaluations: reduction.evaluations.length, finalVerified: reduction.finalVerified,
      directory: reduction.artifactDirectory, minimizedPath: reduction.minimizedPath },
    fixedReduced: { passed: fixedReduced.statistics.passed, directory: fixedReduced.artifactDirectory }, bundle,
  };
  const reportPath = join(reduction.artifactDirectory, 'case-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(reduction.artifactDirectory, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  assert.equal(await readFile(join(cwd, 'fixture.ts'), 'utf8'), source, 'Keep the original fixture intact');
  signal.throwIfAborted();
  console.log(`Affected: ${count(affected)}/3 matches; fixed: ${count(fixed)}/3 matches`);
  console.log(`Reduced ${reduction.originalSize} to ${reduction.minimizedSize} characters in ${reduction.evaluations.length} evaluations`);
  console.log(`Minimized input: ${JSON.stringify(minimized)}`);
  console.log(`Final verification: ${reduction.finalVerified}; fixed release passes the reduced input`);
  console.log(`Report: ${reportPath}`);
  console.log(`Bundle: ${bundle.directory}`);
  console.log('Replay: install dependencies inside the bundle/source directory, then run node ../repro.mjs.');
} catch (error) {
  if (signal.aborted) {
    process.exitCode = interruptedBy === 'SIGTERM' ? 143 : 130;
    console.error(`Investigation interrupted. Saved evidence remains under ${join(cwd, '.failtrace')}.`);
  } else {
    process.exitCode = 2;
    console.error(error instanceof Error ? error.message : String(error));
  }
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

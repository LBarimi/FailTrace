import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compareRuns, createBundle, loadRun, minimizeFailure, runTrials, verifyFix } from '../../dist/core/index.js';

const execute = promisify(execFile);
const fixtures = dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const quote = value => process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const command = `${quote(process.execPath)} check.mjs`;
const changedSource = [{ field: 'source', reason: 'Evaluate the proposed implementation change against the same checks.' }];

async function copyFixture(name, cwd, files) {
  await mkdir(cwd);
  for (const file of files) await copyFile(join(fixtures, name, file), join(cwd, file));
}
async function invoke(args, cwd, expected, signal) {
  let result;
  try { result = { ...await execute(process.execPath, [cli, ...args, '--json'], { cwd, windowsHide: true, signal, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }), code: 0 }; }
  catch (error) { if (typeof error.code !== 'number') throw error; result = error; }
  assert.equal(result.code, expected, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
async function compareAndCheck(baseline, verification, signal) {
  const comparison = await compareRuns({ runA: baseline.artifactDirectory, runB: verification.candidate.artifactDirectory, signal });
  assert.equal(comparison.commandChanged, false);
  assert.equal(comparison.stderr.equal, false);
  const candidate = await loadRun(verification.candidate.artifactDirectory);
  assert(candidate.trials.every(trial => trial.exitCode === 0 && trial.executionMatched === true && trial.error === undefined));
}

async function eventImport(directory, signal) {
  const cwd = join(directory, 'event-import');
  await copyFixture('event-import', cwd, ['check.mjs', 'importer.mjs', 'events.json']);
  const original = await readFile(join(cwd, 'events.json'), 'utf8');
  const baseline = await invoke(['run', command, '--repeat', '3', '--timeout', '10s', '--stderr-contains', 'IMPORT_REVISION_LOST',
    '--require-stdout-contains', 'IMPORT_CHECK_COMPLETED', '--context-input', 'events.json', '--context-source', 'check.mjs', '--context-source', 'importer.mjs'], cwd, 1, signal);
  assert.equal(baseline.trials.filter(trial => trial.failureMatched === true && trial.executionMatched === true).length, 3);
  const predicate = baseline.predicate;
  const reduction = await minimizeFailure({ command, cwd, input: 'events.json', format: 'json', predicate,
    maxEvaluations: 100, timeoutMs: 10_000, signal });
  assert.equal(reduction.status, 'completed');
  assert.equal(reduction.finalVerified, true);
  const reduced = JSON.parse(await readFile(reduction.minimizedPath, 'utf8'));
  assert.equal(reduced.length, 2);
  assert.equal(reduced[0].id, reduced[1].id);
  assert(reduced[1].revision > reduced[0].revision);
  assert.equal(await readFile(join(cwd, 'events.json'), 'utf8'), original);
  // Input-invalid reduction candidates are nonmatches, not accepted reproducers.
  // Capture a checkpoint-enabled final run for the independent replay bundle.
  const replayRun = await runTrials({ command, cwd, repeat: 1, predicate, executionRequirement: baseline.executionRequirement,
    env: { FAILTRACE_INPUT: reduction.minimizedPath }, timeoutMs: 10_000, signal });
  assert(replayRun.trials[0].failureMatched && replayRun.trials[0].executionMatched);
  const bundle = await createBundle({ run: replayRun.artifactDirectory, cwd, files: ['check.mjs', 'importer.mjs'],
    input: reduction.minimizedPath, command: 'node check.mjs', signal });
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
  const replay = await execute(process.execPath, [join(bundle.directory, 'repro.mjs')], { cwd, env, windowsHide: true, signal, timeout: 20_000 })
    .then(() => { throw new Error('Reduced bundle must reproduce its target.'); }, error => error);
  assert.equal(replay.code, 1);
  assert.equal(replay.stderr, '');
  assert.match(replay.stdout, /Target failure reproduced: 1 \/ 1/);
  const options = { command, cwd, baseline: baseline.artifactDirectory, signal, allowChanges: changedSource };
  await appendFile(join(cwd, 'importer.mjs'), '\n// A source edit that leaves the behavior unchanged.\n');
  const ineffective = await verifyFix(options);
  assert.equal(ineffective.status, 'target_observed');
  await writeFile(join(cwd, 'importer.mjs'), 'throw new Error("IMPORT_SETUP_ERROR");\n');
  const unrelated = await verifyFix(options);
  assert.equal(unrelated.status, 'inconclusive');
  assert.equal(unrelated.candidate.unrelatedFailureTrials, 3);
  await writeFile(join(cwd, 'check.mjs'), 'process.exitCode = 0;\n');
  const skipped = await verifyFix(options);
  assert.equal(skipped.status, 'inconclusive');
  assert.equal(skipped.candidate.executionEvidenceMissingTrials, 3);
  await copyFile(join(fixtures, 'event-import', 'check.mjs'), join(cwd, 'check.mjs'));
  await copyFile(join(fixtures, 'event-import', 'importer-fixed.mjs'), join(cwd, 'importer.mjs'));
  const fixed = await invoke(['verify', baseline.id, '--command', command, '--cwd', cwd,
    '--allow-change', 'source:retain the newest revision'], cwd, 0, signal);
  assert.equal(fixed.status, 'target_not_observed');
  assert.equal(fixed.candidate.healthyTrials, 3);
  await compareAndCheck(baseline, fixed, signal);
  const fixedReduced = await runTrials({ command, cwd, repeat: 1, predicate, executionRequirement: baseline.executionRequirement,
    env: { FAILTRACE_INPUT: reduction.minimizedPath }, signal });
  assert.equal(fixedReduced.trials[0].exitCode, 0);
  assert.equal(fixedReduced.trials[0].executionMatched, true);
  return { cwd, command, baseline: baseline.artifactDirectory, fixed: fixed.metadataPath, ineffective: ineffective.metadataPath,
    unrelated: unrelated.metadataPath, skipped: skipped.metadataPath, reduction: join(reduction.artifactDirectory, 'result.json'),
    bundle: bundle.directory,
    observations: { inputRecords: JSON.parse(original).length, reducedRecords: reduced.length, finalVerified: true,
      ineffectiveFix: ineffective.status, unrelatedError: unrelated.status, skippedCheck: skipped.status, validFix: fixed.status, replay: 'target_observed' } };
}

async function asyncCounter(directory, signal) {
  const cwd = join(directory, 'async-counter');
  await copyFixture('async-counter', cwd, ['check.mjs', 'counter.mjs', 'schedule.json']);
  const baseline = await runTrials({ command, cwd, repeat: 6, timeoutMs: 10_000, signal,
    predicate: { kind: 'stderr_contains', value: 'COUNTER_UPDATE_LOST' },
    executionRequirement: { stream: 'stdout', contains: 'COUNTER_CHECK_COMPLETED' },
    captureContext: { inputFiles: ['schedule.json'], sourceFiles: ['check.mjs', 'counter.mjs'] },
  });
  assert.equal(baseline.trials.filter(trial => trial.failureMatched === true).length, 3);
  assert(baseline.trials.every(trial => trial.executionMatched === true));
  const sample = await compareRuns({ runA: baseline.artifactDirectory, signal });
  assert.deepEqual([sample.trialA, sample.trialB], [2, 1]);
  const options = { command, cwd, baseline: baseline.artifactDirectory, signal, allowChanges: changedSource };
  await appendFile(join(cwd, 'counter.mjs'), '\n// A source edit that leaves the behavior unchanged.\n');
  const ineffective = await verifyFix(options);
  assert.equal(ineffective.status, 'target_observed');
  assert.equal(ineffective.candidate.matchedTrials, 3);
  await writeFile(join(cwd, 'counter.mjs'), 'throw new Error("COUNTER_SETUP_ERROR");\n');
  const unrelated = await verifyFix(options);
  assert.equal(unrelated.status, 'inconclusive');
  assert.equal(unrelated.candidate.unrelatedFailureTrials, 6);
  await writeFile(join(cwd, 'check.mjs'), 'process.exitCode = 0;\n');
  const skipped = await verifyFix(options);
  assert.equal(skipped.status, 'inconclusive');
  assert.equal(skipped.candidate.executionEvidenceMissingTrials, 6);
  await copyFile(join(fixtures, 'async-counter', 'check.mjs'), join(cwd, 'check.mjs'));
  await copyFile(join(fixtures, 'async-counter', 'counter-fixed.mjs'), join(cwd, 'counter.mjs'));
  const fixed = await verifyFix(options);
  assert.equal(fixed.status, 'target_not_observed');
  assert.equal(fixed.candidate.healthyTrials, 6);
  await compareAndCheck(baseline, fixed, signal);
  return { cwd, command, baseline: baseline.artifactDirectory, fixed: fixed.metadataPath, ineffective: ineffective.metadataPath,
    unrelated: unrelated.metadataPath, skipped: skipped.metadataPath,
    observations: { predeclaredSchedules: 6, baselineMatches: 3, ineffectiveFix: ineffective.status,
      unrelatedError: unrelated.status, skippedCheck: skipped.status, validFix: fixed.status } };
}

/** Requires a new directory. Importing this example never executes a target. */
export async function investigateWorkflows(directory, signal) {
  directory = resolve(directory);
  signal?.throwIfAborted();
  await mkdir(directory);
  const report = { schemaVersion: 1, eventImport: await eventImport(directory, signal), asyncCounter: await asyncCounter(directory, signal) };
  signal?.throwIfAborted();
  const reportPath = join(directory, 'workflow.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { reportPath, eventImport: report.eventImport.observations, asyncCounter: report.asyncCounter.observations };
}

const isMain = process.argv[1] && await Promise.all([realpath(resolve(process.argv[1])), realpath(fileURLToPath(import.meta.url))])
  .then(([invoked, module]) => invoked === module, () => false);
if (isMain) {
  const controller = new AbortController();
  let exitCode;
  const interrupt = code => { exitCode ??= code; controller.abort(); };
  const onSigint = () => interrupt(130);
  const onSigterm = () => interrupt(143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node examples/workflows/investigate.mjs');
    const parent = resolve('.failtrace', 'workflows');
    await mkdir(parent, { recursive: true });
    const result = await investigateWorkflows(join(parent, randomUUID()), controller.signal);
    console.log(JSON.stringify({ ...result, reportPath: relative(process.cwd(), result.reportPath) }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = exitCode ?? 2;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

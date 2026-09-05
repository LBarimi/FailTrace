import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { quoteExecutable } from './config.mjs';

const { directory, corePath, fixtureDirectory, configuration } = JSON.parse(process.argv[2]);
const api = await import(pathToFileURL(corePath).href);
await mkdir(directory); // Each worker receives a new owned directory.
for (const file of ['check.mjs', 'importer.mjs']) await copyFile(join(fixtureDirectory, file), join(directory, file));
const records = configuration.records;
assert(Number.isSafeInteger(records) && records >= 4 && records <= 10000 && records % 2 === 0);
assert([0, 1048576].includes(configuration.outputBytes));
assert(['direct-shell', 'run', 'checkpoint', 'workflow'].includes(configuration.mode));
assert(Number.isSafeInteger(configuration.repeat) && configuration.repeat >= 1 && configuration.repeat <= 20);
const events = [1, 2].flatMap(revision => Array.from({ length: records / 2 }, (_, index) => ({ id: `entity-${index}`, revision })));
const input = `${JSON.stringify(events)}\n`;
await writeFile(join(directory, 'events.json'), input);
await writeFile(join(directory, 'benchmark-check.mjs'), `process.stdout.write('x'.repeat(${configuration.outputBytes}));\nawait import('./check.mjs');\n`);
const command = `${quoteExecutable(process.execPath)} benchmark-check.mjs`;
const predicate = { kind: 'stderr_contains', value: 'IMPORT_REVISION_LOST' };
const executionRequirement = { stream: 'stdout', contains: 'IMPORT_CHECK_COMPLETED' };
const options = { command, cwd: directory, repeat: configuration.repeat, timeoutMs: 30000, predicate };
const stages = [];
async function measure(phase, operation) {
  globalThis.__failtraceBenchmark.reset();
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await operation();
  const wallMs = performance.now() - started;
  const usage = process.cpuUsage(cpu);
  const io = globalThis.__failtraceBenchmark.snapshot();
  stages.push({ phase, wallMs, cpuMs: (usage.user + usage.system) / 1000,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, metadataBytesWritten: io.metadataBytesWritten,
    fsyncCalls: io.fsyncCalls, unmeasuredWriteCalls: io.unmeasuredWriteCalls });
  return result;
}
async function sizeOf(path) {
  let bytes = 0; let files = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) { const nested = await sizeOf(child); bytes += nested.bytes; files += nested.files; }
    else { assert(entry.isFile()); bytes += (await stat(child)).size; files++; }
  }
  return { bytes, files };
}
let outcomes;
if (configuration.mode === 'direct-shell') {
  await measure('run', async () => {
    for (let index = 1; index <= configuration.repeat; index++) {
      const stdout = await open(join(directory, `stdout-${index}.txt`), 'wx');
      const stderr = await open(join(directory, `stderr-${index}.txt`), 'wx');
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(command, { cwd: directory, shell: true, windowsHide: true,
            env: { ...process.env, FAILTRACE_TRIAL_INDEX: String(index) }, stdio: ['ignore', stdout.fd, stderr.fd], timeout: 30000 });
          child.once('error', reject);
          child.once('close', (code, signal) => code === 7 && signal === null ? resolve() : reject(new Error('Unexpected authored target outcome.')));
        });
      } finally { await stdout.close(); await stderr.close(); }
    }
  });
  outcomes = { completedTrials: configuration.repeat, expectedExit: 7 };
} else if (configuration.mode !== 'workflow') {
  const run = await measure('run', () => api.runTrials({ ...options,
    ...(configuration.mode === 'checkpoint' ? { executionRequirement } : {}) }));
  assert.equal(run.status, 'completed');
  assert.equal(run.trials.length, configuration.repeat);
  assert(run.trials.every(trial => trial.exitCode === 7 && trial.failureMatched === true && !trial.error));
  if (configuration.mode === 'checkpoint') assert(run.trials.every(trial => trial.executionMatched === true));
  outcomes = { completedTrials: run.trials.length, matchedTrials: run.trials.length };
} else {
  const baseline = await measure('baseline', () => api.runTrials({ ...options, executionRequirement,
    captureContext: { inputFiles: ['events.json'], sourceFiles: ['check.mjs', 'importer.mjs', 'benchmark-check.mjs'] } }));
  assert(baseline.trials.every(trial => trial.failureMatched === true && trial.executionMatched === true));
  const reduction = await measure('minimize', () => api.minimizeFailure({ command, cwd: directory, input: 'events.json',
    format: 'json', predicate, repeat: 1, timeoutMs: 30000, maxEvaluations: 100 }));
  assert.equal(reduction.status, 'completed');
  assert.equal(reduction.finalVerified, true);
  const reduced = JSON.parse(await readFile(reduction.minimizedPath, 'utf8'));
  assert.equal(reduced.length, 2);
  assert.equal(reduced[0].id, reduced[1].id);
  assert(reduced[0].revision < reduced[1].revision);
  assert.equal(await readFile(join(directory, 'events.json'), 'utf8'), input);
  const final = await measure('reduced-checkpoint', () => api.runTrials({ ...options, repeat: 1, executionRequirement,
    env: { FAILTRACE_INPUT: reduction.minimizedPath } }));
  assert(final.trials[0].failureMatched && final.trials[0].executionMatched);
  const bundle = await measure('bundle', () => api.createBundle({ cwd: directory, run: final.artifactDirectory,
    files: ['check.mjs', 'importer.mjs', 'benchmark-check.mjs'], input: reduction.minimizedPath, command: 'node benchmark-check.mjs' }));
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
  const replay = await measure('replay', () => promisify(execFile)(process.execPath, [join(bundle.directory, 'repro.mjs')],
    { cwd: directory, env, windowsHide: true, timeout: 30000 }).then(() => { throw new Error('Replay should reproduce the target.'); }, error => error));
  assert.equal(replay.code, 1);
  assert.equal(replay.stderr, '');
  assert.match(replay.stdout, /Target failure reproduced: 1 \/ 1/);
  const verify = { baseline: baseline.artifactDirectory, command, cwd: directory,
    allowChanges: [{ field: 'source', reason: 'Evaluate the authored implementation intervention.' }] };
  await appendFile(join(directory, 'importer.mjs'), '\n// Ineffective source edit.\n');
  const ineffective = await measure('ineffective-fix', () => api.verifyFix(verify));
  assert.equal(ineffective.status, 'target_observed');
  await writeFile(join(directory, 'importer.mjs'), 'throw new Error("IMPORT_SETUP_ERROR");\n');
  const unrelated = await measure('unrelated-error', () => api.verifyFix(verify));
  assert.equal(unrelated.status, 'inconclusive');
  assert.equal(unrelated.candidate.unrelatedFailureTrials, configuration.repeat);
  await writeFile(join(directory, 'check.mjs'), 'process.exitCode = 0;\n');
  const skipped = await measure('skipped-check', () => api.verifyFix(verify));
  assert.equal(skipped.status, 'inconclusive');
  assert.equal(skipped.candidate.executionEvidenceMissingTrials, configuration.repeat);
  await copyFile(join(fixtureDirectory, 'check.mjs'), join(directory, 'check.mjs'));
  await copyFile(join(fixtureDirectory, 'importer-fixed.mjs'), join(directory, 'importer.mjs'));
  const fixed = await measure('valid-fix', () => api.verifyFix(verify));
  assert.equal(fixed.status, 'target_not_observed');
  assert.equal(fixed.candidate.healthyTrials, configuration.repeat);
  const comparison = await measure('compare', () => api.compareRuns({ runA: baseline.artifactDirectory, runB: fixed.candidate.artifactDirectory }));
  assert.equal(comparison.stderr.equal, false);
  const inventory = await measure('inventory', () => api.inventoryArtifacts({ cwd: directory, maxEntries: 100000 }));
  assert.equal(inventory.complete, true);
  outcomes = { initialRecords: records, reducedRecords: reduced.length, evaluations: reduction.evaluations.length,
    finalVerified: true, ineffectiveFix: ineffective.status, unrelatedError: unrelated.status,
    skippedCheck: skipped.status, validFix: fixed.status, replay: 'target_observed',
    evidenceBytes: inventory.bytes, evidenceFiles: inventory.files };
}
const artifact = await sizeOf(directory);
// Keep all target paths, commands, metadata and output in the owned worker directory.
console.log(JSON.stringify({ stages, outcomes, artifact }));

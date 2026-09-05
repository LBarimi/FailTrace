#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Build first. node scripts/bench-workflows.mjs [--samples 1..5] [--records even:4..10000] [--repeat 1..20] [--core built-core-index] [--output NEW_DIRECTORY]\nDefaults: 3 sequential samples, 2000 records, 5 trials per sample. Original controlled importer; no external services.');
  process.exit(0);
}
const options = { samples: 3, records: 2000, repeat: 5 };
for (let index = 0; index < args.length; index += 2) {
  const key = args[index].slice(2); const value = args[index + 1];
  if (!args[index].startsWith('--') || !['samples', 'records', 'repeat', 'core', 'output'].includes(key) || !value || value.startsWith('--')) throw new Error('Invalid workflow benchmark option.');
  options[key] = ['core', 'output'].includes(key) ? value : Number(value);
}
for (const [key, min, max] of [['samples', 1, 5], ['records', 4, 10000], ['repeat', 1, 20]]) {
  if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid ${key} benchmark budget.`);
}
if (options.records % 2) throw new Error('The record count must be even.');
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceCore = resolve(options.core ?? join(root, 'dist/core/index.js'));
if (!(await stat(sourceCore)).isFile()) throw new Error('Build Core before benchmarking.');
const output = resolve(options.output ?? join(root, '.failtrace', 'benchmarks', `workflows-${randomUUID()}`));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Never replace an existing report or reuse an experiment.
const engine = join(output, 'package', 'dist', 'core');
const fixtures = join(output, 'fixtures');
await mkdir(dirname(engine), { recursive: true });
await cp(dirname(sourceCore), engine, { recursive: true, errorOnExist: true, force: false });
await copyFile(resolve(dirname(sourceCore), '../../LICENSE'), join(output, 'package', 'LICENSE'));
await writeFile(join(engine, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
await cp(join(root, 'examples/workflows/event-import'), fixtures, { recursive: true, errorOnExist: true, force: false });
await mkdir(join(output, 'cases'));
async function digestTree(directory, accept) {
  const hash = createHash('sha256');
  for (const file of (await readdir(directory)).sort()) {
    if (accept(file)) hash.update(file).update('\0').update(await readFile(join(directory, file))).update('\0');
  }
  return hash.digest('hex');
}
const phases = new Set(['run', 'baseline', 'minimize', 'reduced-checkpoint', 'bundle', 'replay',
  'ineffective-fix', 'unrelated-error', 'skipped-check', 'valid-fix', 'compare', 'inventory']);
const metrics = ['wallMs', 'cpuMs', 'peakRssBytes', 'metadataBytesWritten', 'fsyncCalls', 'unmeasuredWriteCalls'];
const outcomeKeys = ['completedTrials', 'expectedExit', 'matchedTrials', 'initialRecords', 'reducedRecords', 'evaluations',
  'finalVerified', 'ineffectiveFix', 'unrelatedError', 'skippedCheck', 'validFix', 'replay', 'evidenceBytes', 'evidenceFiles'];
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), source: 'unreleased source candidate',
  coreJavaScriptSha256: await digestTree(engine, name => name.endsWith('.js')),
  fixtureSha256: await digestTree(fixtures, name => /\.(mjs|json)$/.test(name)),
  host: { platform: platform(), arch: arch(), node: process.version },
  configuration: { samples: options.samples, records: options.records, repeat: options.repeat, maxMinimizationEvaluations: 100 },
  methodology: {
    target: 'Authored importer keeps the first entity revision; generated input places revision 1 then 2 for every ID. The independent checker scans each ID and is quadratic in record count. This is a controlled workload, not an external production incident.',
    output: 'The same wrapper emits either zero or 1 MiB of stdout before the check in each paired case. Checkpoint matching reads the completed-check marker near the end. The target predicate reads stderr.',
    wall: 'Per-operation wall time after worker import and fixture preparation; includes shell/target startup, experiment execution and evidence persistence. Source interventions are outside the timed regions. Replay includes the separate replay engine process.',
    cpu: 'Parent process CPU delta only; excludes shell, target and replay subprocesses. RSS is process-lifetime peak, including imports and earlier stages in workflow workers.',
    io: 'Existing JavaScript filesystem instrumentation; logical metadata writes and sync calls, not physical disk operations. Child direct-FD output and replay child I/O are outside the parent counters.',
    artifact: 'Final logical file lengths outside timing; includes fixture copies in artifact totals. Workflow evidenceBytes/evidenceFiles separately inventory only .failtrace.',
    baseline: 'Direct shell records output and requires exit 7; it omits predicates, completed-check validation and durable metadata. It is a lower-cost execution reference, not an equivalent debugging tool.',
    sampling: 'Sequential samples in fixed case order, new workers and directories, with a single copied engine/fixture snapshot. Filesystem caches and background OS load are not controlled.',
    privacy: 'This report includes only selected labels, counts, hashes and measurements. Local paths, command strings, output, source patches and environment values stay in private worker artifacts.',
  }, results: [], aggregates: [] };
const configurations = [];
for (const [records, outputBytes] of [...new Map([[12, 0], [options.records, 0], [options.records, 1048576]].map(pair => [pair.join('/'), pair])).values()]) {
  for (const mode of ['direct-shell', 'run', 'checkpoint']) configurations.push({ mode, records, outputBytes, repeat: options.repeat });
}
configurations.push({ mode: 'workflow', records: options.records, outputBytes: 0, repeat: options.repeat });
const execute = promisify(execFile);
for (let sample = 1; sample <= options.samples; sample++) {
  for (const [index, configuration] of configurations.entries()) {
    const id = `sample-${sample}-case-${index + 1}`;
    process.stderr.write(`${id}: ${configuration.mode}, ${configuration.records} records, ${configuration.outputBytes} output bytes\n`);
    const { stdout, stderr } = await execute(process.execPath, ['--import', new URL('./bench/instrument.mjs', import.meta.url).href,
      fileURLToPath(new URL('./bench/workflow-worker.mjs', import.meta.url)), JSON.stringify({
        directory: join(output, 'cases', id), corePath: join(engine, basename(sourceCore)), fixtureDirectory: fixtures, configuration,
      })], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    assert.equal(stderr, '');
    const data = JSON.parse(stdout);
    const stages = data.stages.map(stage => {
      assert(phases.has(stage.phase));
      const result = { phase: stage.phase };
      for (const key of metrics) { assert(Number.isFinite(stage[key]) && stage[key] >= 0); result[key] = stage[key]; }
      assert.equal(stage.unmeasuredWriteCalls, 0);
      return result;
    });
    const outcomes = Object.fromEntries(outcomeKeys.filter(key => Object.hasOwn(data.outcomes, key)).map(key => {
      const value = data.outcomes[key];
      assert(typeof value === 'boolean' || Number.isFinite(value) || ['target_observed', 'target_not_observed', 'inconclusive'].includes(value));
      return [key, value];
    }));
    for (const key of ['bytes', 'files']) assert(Number.isSafeInteger(data.artifact[key]) && data.artifact[key] >= 0);
    report.results.push({ sample, ...configuration, stages, outcomes, artifact: { bytes: data.artifact.bytes, files: data.artifact.files } });
    await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}
const aggregate = new Map();
for (const result of report.results) for (const stage of result.stages) {
  const key = `${result.mode}/${result.records}/${result.outputBytes}/${stage.phase}`;
  const group = aggregate.get(key) ?? { mode: result.mode, records: result.records, outputBytes: result.outputBytes, phase: stage.phase,
    values: Object.fromEntries(metrics.map(metric => [metric, []])) };
  for (const metric of metrics) group.values[metric].push(stage[metric]);
  aggregate.set(key, group);
}
report.aggregates = [...aggregate.values()].map(({ values, ...key }) => ({ ...key, metrics: Object.fromEntries(metrics.map(metric => {
  const sorted = values[metric].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return [metric, { min: sorted[0], median: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2, max: sorted.at(-1) }];
})) }));
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: 'passed', samples: options.samples, cases: report.results.length,
  coreJavaScriptSha256: report.coreJavaScriptSha256 }));

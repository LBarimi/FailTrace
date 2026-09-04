#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCases, checkBudgets, parseOptions } from './bench/config.mjs';

const options = parseOptions(process.argv.slice(2));
if (options.help) {
  console.log(`FailTrace performance benchmark (build Core first)
  node scripts/bench.mjs [--suite smoke|ci|full] [--check]
    [--durations noop,10ms,100ms,1s] [--repeats 1,10,100,1000]
    [--outputs 0,10KiB,1MiB] [--predicates nonzero_exit,exit_code,substring,regex]
    [--core path/to/dist/core/index.js] [--output owned-output-directory] [--label label]
    [--hash] [--experiments]
Default smoke is six representative cases. Axis filters select a Cartesian matrix;
unspecified axes use the full values. Full suite is intentionally expensive.
Output contains measurements only; local paths and environment values are omitted.`);
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const id = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(options.output ?? join(root, '.failtrace', 'benchmarks', id));
await mkdir(dirname(output), { recursive: true });
// Exclusive ownership is established before copying fixtures or creating reports.
await mkdir(output);
const sourceCore = resolve(options.core ?? join(root, 'dist', 'core', 'index.js'));
const snapshotDirectory = join(output, 'engine');
await cp(dirname(sourceCore), snapshotDirectory, { recursive: true, errorOnExist: true, force: false });
await writeFile(join(snapshotDirectory, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
const corePath = join(snapshotDirectory, basename(sourceCore));
const codeHash = createHash('sha256');
async function hashCore(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await hashCore(join(directory, entry.name), `${name}/`);
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
      codeHash.update(name).update('\0').update(await readFile(join(directory, entry.name))).update('\0');
    }
  }
}
await hashCore(snapshotDirectory);
const hook = pathToFileURL(fileURLToPath(new URL('./bench/instrument.mjs', import.meta.url))).href;
const worker = fileURLToPath(new URL('./bench/worker.mjs', import.meta.url));
const cases = buildCases(options);
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), label: options.label ?? 'working-tree',
  suite: options.suite, coreJavaScriptSha256: codeHash.digest('hex'), host: { platform: platform(), arch: arch(), osRelease: release(), node: process.version },
  methodology: {
    wall: 'Measured inside an isolated worker after module import and fixture setup; includes target startup/execution, evidence, predicates and final metadata. Worker startup is separately recorded.',
    cpu: 'process.cpuUsage delta for the FailTrace/direct runner process, including its worker threads, excluding target and shell subprocesses.',
    peakRss: 'process.resourceUsage().maxRSS converted from KiB to bytes; process lifetime peak includes startup/import. Null means unavailable. Does not include target/shell RSS.',
    io: 'Instrumented node:fs/promises and FileHandle API calls in the runner process, not OS syscalls. Successful logical write bytes and attempted/completed fsync/datasync calls. Excludes child direct-FD writes, callback/synchronous fs APIs, recursive internal calls, regex worker I/O and kernel caching/physical device writes.',
    artifact: 'Final on-disk file lengths, measured after timing; includes output and metadata, excludes fixture/report. Logical file size, not allocated filesystem blocks.',
    baselines: 'Identical Node fixture/environment/trial indices with file-descriptor stdout/stderr, sequential spawn via shell or executable+argv. No FailTrace predicates or durable metadata.',
    target: 'Every trial exits 1; writes exactly outputBytes to stdout and none to stderr. Positive outputs contain the matching sentinel; zero-byte text/regex predicates intentionally do not match. Delay excludes Node startup.',
    privacy: 'Reports omit command paths, working directories, environment values and usernames. Raw local artifacts remain private under the output directory.',
    code: 'Built Core is copied once before worker execution; its JavaScript file names and contents are SHA-256 fingerprinted. Build before benchmarking. Benchmark results do not change if dist is rebuilt concurrently.',
  }, results: [], budget: null };
async function run(mode, configuration) {
  const id = `${mode}-${configuration.durationMs}ms-${configuration.repeat}x-${configuration.outputBytes}b-${configuration.predicate}${configuration.experiment ? `-${configuration.experiment}` : ''}`;
  process.stderr.write(`${report.results.length + 1}: ${id}\n`);
  const started = performance.now();
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', hook, worker, JSON.stringify({ mode, directory: join(output, 'cases', id), corePath, configuration })],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`Benchmark worker failed (${id}): ${stderr}`));
      else { try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error(`Invalid worker result (${id}).`)); } }
    });
  });
  report.results.push({ id, ...result, workerWallMs: performance.now() - started });
}
const baselines = new Set();
for (const configuration of cases) {
  const key = `${configuration.durationMs}-${configuration.repeat}-${configuration.outputBytes}`;
  if (!baselines.has(key)) {
    await run('direct-argv', configuration);
    await run('direct-shell', configuration);
    baselines.add(key);
  }
  await run('failtrace', configuration);
}
if (options.experiments) {
  const make = (durationMs, experiment, extras = {}) => ({ durationMs, repeat: 10, outputBytes: 0, predicate: 'nonzero_exit', experiment, ...extras });
  for (const configuration of [make(10, 'full'), make(10, 'decision', { minFailures: 1 }),
    make(100, 'sequential', { concurrency: 1 }), make(100, 'parallel', { concurrency: 4 }),
    make(1000, 'sequential', { concurrency: 1 }), make(1000, 'parallel', { concurrency: 4 })]) await run('failtrace', configuration);
}
if (options.hash) {
  process.stderr.write('Compare hash tradeoff: two 16 MiB logs, ten comparisons\n');
  report.hashExperiment = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', hook, fileURLToPath(new URL('./bench/hash-worker.mjs', import.meta.url)),
      JSON.stringify({ directory: join(output, 'hash'), corePath })], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`Hash worker failed: ${stderr}`));
      else { try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('Invalid hash worker result.')); } }
    });
  });
}
report.budget = { checked: options.check, failures: options.check ? checkBudgets(report.results) : [] };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const rows = report.results.map((result) => `| ${result.id} | ${result.wallMs.toFixed(1)} | ${(result.cpuUserMs + result.cpuSystemMs).toFixed(1)} | ${result.peakRssBytes ?? 'n/a'} | ${result.io.metadataBytesWritten} | ${result.io.fsyncCalls} | ${result.artifact.bytes} |`);
await writeFile(join(output, 'report.md'), `# FailTrace benchmark: ${report.label}\n\n${report.host.platform} ${report.host.arch}, Node ${report.host.node}. See report.json for instrumentation caveats.\n\n| Case | Wall ms | Parent CPU ms | Peak RSS bytes | Metadata bytes written | fsync calls | Artifact bytes |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n`);
console.log(`Benchmark report: ${join(output, 'report.json')}`);
if (report.budget.failures.length) {
  for (const failure of report.budget.failures) console.error(failure);
  process.exitCode = 1;
}

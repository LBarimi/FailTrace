#!/usr/bin/env node
// Usage: node scripts/package-smoke.mjs [path/to/failtrace-version.tgz] [--keep]
// Packs the checkout when no tarball is supplied. Installs only into a fresh
// temporary consumer, then exercises its installed CLI, Core and demo.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const keep = arguments_.includes('--keep');
const inputs = arguments_.filter((argument) => argument !== '--keep');
if (inputs.length > 1 || inputs.some((argument) => argument.startsWith('--'))) {
  throw new Error('Usage: node scripts/package-smoke.mjs [tarball.tgz] [--keep]');
}

async function npmCli() {
  const candidates = [process.env.npm_execpath];
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  const search = [dirname(process.execPath), ...(process.env[pathKey] ?? '').split(delimiter).filter(Boolean)];
  for (const directory of search) {
    candidates.push(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    try {
      const executable = await realpath(join(directory, 'npm'));
      if (basename(executable) === 'npm-cli.js') candidates.push(executable);
    } catch { /* This PATH entry does not provide npm. */ }
  }
  for (const candidate of candidates) {
    if (candidate && basename(candidate) === 'npm-cli.js') {
      try { if ((await stat(candidate)).isFile()) return await realpath(candidate); } catch { /* Try the next location. */ }
    }
  }
  throw new Error('Cannot locate npm-cli.js. Run through npm exec, or set npm_execpath to your npm-cli.js path.');
}

// This function is written into the isolated consumer. Every import resolves
// there, so source-checkout modules cannot accidentally satisfy the smoke test.
async function exerciseInstalledCore() {
  const assert = (await import('node:assert/strict')).default;
  const { mkdir, readFile, realpath, writeFile } = await import('node:fs/promises');
  const { dirname, join, relative, isAbsolute } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const api = await import('failtrace');
  const consumer = dirname(fileURLToPath(import.meta.url));
  const installed = await realpath(join(consumer, 'node_modules', 'failtrace'));
  const imported = await realpath(fileURLToPath(import.meta.resolve('failtrace')));
  const within = relative(installed, imported);
  assert(!isAbsolute(within) && within !== '..' && !within.startsWith('..'), 'Core must resolve from the installed tarball');
  assert.equal(api.VERSION, process.env.FAILTRACE_SMOKE_VERSION);
  for (const name of ['runTrials', 'compareRuns', 'bisectRegression', 'minimizeFailure', 'createBundle']) {
    assert.equal(typeof api[name], 'function', `Missing public Core export: ${name}`);
  }
  const project = join(consumer, 'independent project');
  await mkdir(project);
  const target = join(project, 'target.mjs');
  await writeFile(target, 'process.stdout.write("trial " + process.env.FAILTRACE_TRIAL_INDEX + "\\n");\n'
    + 'process.stderr.write("captured evidence\\n");\n'
    + 'process.exitCode = Number(process.env.FAILTRACE_TRIAL_INDEX) % 2 === 0 ? 7 : 0;\n');
  const quote = (value) => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const run = await api.runTrials({
    command: `${quote(process.execPath)} ${quote(target)}`,
    cwd: project, repeat: 4, timeoutMs: 5_000, predicate: { kind: 'exit_code', value: 7 },
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.statistics.total, 4);
  assert.equal(run.statistics.passed, 2);
  assert.equal(run.statistics.failed, 2);
  assert.equal(run.statistics.failureRate, 0.5);
  assert.equal(await readFile(join(run.artifactDirectory, run.trials[0].stdoutPath), 'utf8'), 'trial 1\n');
  assert.equal(await readFile(join(run.artifactDirectory, run.trials[1].stderrPath), 'utf8'), 'captured evidence\n');
  const comparison = await api.compareRuns({ runA: run.artifactDirectory });
  assert.equal(comparison.stdout.equal, false);
  assert.equal(comparison.stderr.equal, true);
  console.log(JSON.stringify({
    total: run.statistics.total, failed: run.statistics.failed,
    artifactDirectory: run.artifactDirectory, comparison: 'passed',
  }));
}

const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'failtrace');
const npm = await npmCli();
const temporaryParent = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryParent, 'failtrace-package-smoke-'));
const consumer = join(temporary, 'consumer');
const environment = { ...process.env };
delete environment.NODE_PATH;
environment.FAILTRACE_SMOKE_VERSION = manifest.version;
const npmRun = (args, cwd) => execute(process.execPath, [npm, ...args], {
  cwd, env: environment, windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
});

try {
  let tarball;
  if (inputs[0]) {
    tarball = await realpath(resolve(inputs[0]));
    assert((await stat(tarball)).isFile(), 'Supply a local tarball file');
  } else {
    const packed = join(repository, '.failtrace', 'package-smoke', randomUUID());
    await mkdir(packed, { recursive: true });
    await npmRun(['pack', '--pack-destination', packed, '--json'], repository);
    tarball = join(packed, `${manifest.name}-${manifest.version}.tgz`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(tarball)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"name":"failtrace-package-consumer","private":true,"type":"module"}\n');
  // Installing a packed artifact should not require compiler/test dependencies
  // or lifecycle scripts. Runtime dependencies still come from npm normally.
  await npmRun(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--no-save', tarball], consumer);
  const installedDirectory = join(consumer, 'node_modules', 'failtrace');
  const installed = JSON.parse(await readFile(join(installedDirectory, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.mcpName, manifest.mcpName, 'Preserve the verified MCP Registry identity');
  const server = JSON.parse(await readFile(join(installedDirectory, 'server.json'), 'utf8'));
  assert.equal(server.name, installed.mcpName);
  assert.equal(server.version, installed.version);
  assert(server.packages.some(entry => entry.registryType === 'npm' && entry.identifier === installed.name
    && entry.version === installed.version && entry.transport.type === 'stdio'), 'MCP metadata must identify this installed npm version');
  assert.equal((await lstat(installedDirectory)).isSymbolicLink(), false, 'Tarball install must not link back to the source checkout');
  for (const entry of await readdir(join(installedDirectory, 'examples'), { recursive: true })) {
    assert(!entry.split(/[\\/]/).some(part => ['node_modules', '.failtrace', '.cache'].includes(part)),
      `Packaged examples must not contain installed dependencies or local evidence: ${entry}`);
  }
  for (const dependency of ['typescript', 'vitest', '@modelcontextprotocol/client']) {
    await assert.rejects(stat(join(consumer, 'node_modules', dependency)), { code: 'ENOENT' }, `Unexpected development dependency: ${dependency}`);
    await assert.rejects(stat(join(installedDirectory, 'node_modules', dependency)), { code: 'ENOENT' }, `Unexpected nested development dependency: ${dependency}`);
  }
  const cliVersion = await npmRun(['exec', '--offline', '--', 'failtrace', '--version'], consumer);
  assert.equal(cliVersion.stdout.trim(), manifest.version);
  await writeFile(join(consumer, 'core-smoke.mjs'), `await (${exerciseInstalledCore.toString()})();\n`);
  const coreOutput = await execute(process.execPath, ['core-smoke.mjs'], {
    cwd: consumer, env: environment, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  const core = JSON.parse(coreOutput.stdout);
  const help = await npmRun(['exec', '--offline', '--', 'failtrace', '--help'], consumer);
  assert(/\bfailtrace demo\b/.test(help.stdout), 'Installed CLI must advertise the demo');
  const demoOutput = await npmRun(['exec', '--offline', '--', 'failtrace', 'demo', '--json'], consumer);
  const demo = JSON.parse(demoOutput.stdout);
  assert.equal(demo.status, 'completed');
  assert.equal(demo.repetition.statistics.total, 10);
  assert.equal(demo.repetition.statistics.passed, 7);
  assert.equal(demo.repetition.statistics.failed, 3);
  assert.equal(demo.reduction.finalVerified, true);
  assert.deepEqual(demo.reduction.minimizedInput, ['BUG']);
  assert((await stat(demo.bundle.directory)).isDirectory());
  const report = {
    package: manifest.name, version: manifest.version, tarball, sha256,
    checks: { installedCli: 'passed', installedCore: 'passed', productionDependenciesOnly: 'passed', installedDemo: 'passed' },
    core: { total: core.total, failed: core.failed, comparison: core.comparison },
    retained: keep,
    ...(keep ? { consumerDirectory: consumer, coreRunDirectory: core.artifactDirectory,
      demoDirectory: demo.artifactDirectory, bundleDirectory: demo.bundle.directory } : {}),
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (keep) console.error(`Retained package smoke files: ${temporary}`);
  throw error;
} finally {
  if (!keep) {
    // Only remove the exact fresh directory this invocation created.
    assert.equal(dirname(temporary), temporaryParent);
    assert(basename(temporary).startsWith('failtrace-package-smoke-'));
    assert.equal(await realpath(temporary), temporary);
    assert(!relative(temporaryParent, temporary).includes('/'));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

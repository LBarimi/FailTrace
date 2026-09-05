#!/usr/bin/env node
// Usage: node scripts/package-smoke.mjs [path/to/failtrace-version.tgz] [--keep]
// Packs the checkout when no tarball is supplied. Installs only into a fresh
// temporary consumer, then exercises its installed CLI, Core, MCP and demo.
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
  for (const name of ['runTrials', 'compareRuns', 'bisectRegression', 'minimizeFailure', 'verifyFix', 'createBundle', 'inspectRunEvidence']) {
    assert.equal(typeof api[name], 'function', `Missing public Core export: ${name}`);
  }
  const project = join(consumer, 'independent project');
  await mkdir(project);
  await assert.rejects(api.runTrials({ cwd: project, command: 'unused', repeat: 100001 }), /100000/);
  await assert.rejects(api.runTrials({ cwd: project, command: 'unused', concurrency: 65 }), /64/);
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
  const firstMatches = await api.inspectRunEvidence({
    view: 'trials', run: run.artifactDirectory, filter: 'matched', limit: 1,
  });
  assert.equal(firstMatches.recordedTrials, 4);
  assert.equal(firstMatches.matchedTrials, 2);
  assert.deepEqual(firstMatches.trials.map((trial) => trial.index), [2]);
  assert.equal(firstMatches.nextAfterTrial, 2);
  const remainingMatches = await api.inspectRunEvidence({
    view: 'trials', run: run.artifactDirectory, filter: 'matched', limit: 1,
    afterTrial: firstMatches.nextAfterTrial,
  });
  assert.deepEqual(remainingMatches.trials.map((trial) => trial.index), [4]);
  assert.equal(remainingMatches.nextAfterTrial, null);
  const firstOutput = await api.inspectRunEvidence({
    view: 'output', run: run.artifactDirectory, trial: 2, stream: 'stdout', maxBytes: 5,
  });
  assert.equal(firstOutput.text, 'trial');
  assert.equal(firstOutput.nextOffsetBytes, 5);
  const remainingOutput = await api.inspectRunEvidence({
    view: 'output', run: run.artifactDirectory, trial: 2, stream: 'stdout',
    offsetBytes: firstOutput.nextOffsetBytes, maxBytes: 8,
  });
  assert.equal(firstOutput.text + remainingOutput.text, 'trial 2\n');
  assert.equal(remainingOutput.nextOffsetBytes, null);
  const noisy = join(project, 'noisy.mjs');
  await writeFile(noisy, "process.stdout.write('x'.repeat(64));\n");
  const bounded = await api.runTrials({ command: `${quote(process.execPath)} ${quote(noisy)}`, cwd: project,
    repeat: 2, maxOutputBytes: 32, maxTotalOutputBytes: 48 });
  assert.equal(bounded.status, 'resource_limited');
  assert.equal(api.assessRun(bounded), 'inconclusive');
  assert.equal(bounded.trials.length, 1);
  assert.equal((await readFile(join(bounded.artifactDirectory, bounded.trials[0].stdoutPath))).length, 32);
  await writeFile(join(project, 'input.txt'), 'BUG');
  const storage = await api.minimizeFailure({ cwd: project, command: `${quote(process.execPath)} ${quote(noisy)}`,
    input: 'input.txt', format: 'text', maxInputBytes: 3, maxCandidateBytes: 3 });
  assert.equal(storage.status, 'limit_reached');
  assert.equal(storage.finalVerified, false);
  assert.equal(storage.evaluations.length, 0);
  assert.equal(await readFile(storage.minimizedPath, 'utf8'), 'BUG');
  console.log(JSON.stringify({
    total: run.statistics.total, failed: run.statistics.failed,
    artifactDirectory: run.artifactDirectory, comparison: 'passed', inspection: 'passed',
  }));
}

// As above, this runs inside the consumer and resolves only installed Core/CLI.
async function exerciseInstalledVerification() {
  const assert = (await import('node:assert/strict')).default;
  const { execFile } = await import('node:child_process');
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { promisify } = await import('node:util');
  const { verifyFix } = await import('failtrace');
  const execute = promisify(execFile);
  const consumer = dirname(fileURLToPath(import.meta.url));
  const cli = join(consumer, 'node_modules', 'failtrace', 'dist', 'cli', 'index.js');
  const cwd = join(consumer, 'verification project');
  await mkdir(cwd);
  const target = join(cwd, 'target.mjs');
  await writeFile(join(cwd, 'input.json'), '["BUG"]\n');
  await writeFile(join(cwd, 'setup.json'), '{"fixture":1}\n');
  const affected = "import { readFileSync } from 'node:fs';\n"
    + "if (JSON.parse(readFileSync('input.json', 'utf8')).includes('BUG')) { console.error('SMOKE_TARGET'); process.exitCode = 7; }\n";
  const fixed = "import { readFileSync } from 'node:fs'; JSON.parse(readFileSync('input.json', 'utf8')); console.log('healthy');\n";
  const unrelated = "throw new Error('UNRELATED_SMOKE_FAILURE');\n";
  await writeFile(target, affected);
  const quote = (value) => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} target.mjs`;
  const invoke = async (args, expectedCode) => {
    let result;
    try {
      result = { ...await execute(process.execPath, [cli, ...args], { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }), code: 0 };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      result = error;
    }
    assert.equal(result.code, expectedCode, result.stderr);
    assert.equal(result.stderr, '', 'JSON CLI should reserve stdout for one result and remain quiet on stderr');
    return JSON.parse(result.stdout);
  };
  const baseline = await invoke(['run', command, '--repeat', '2', '--timeout', '5s', '--stderr-contains', 'SMOKE_TARGET',
    '--context-input', 'input.json', '--context-setup', 'setup.json', '--context-source', 'target.mjs', '--json'], 1);
  assert(baseline.context, 'Installed CLI must capture baseline context');
  const options = { baseline: baseline.artifactDirectory, command, cwd };
  assert.equal((await verifyFix(options)).status, 'target_observed');
  await writeFile(target, fixed);
  const allowChanges = [{ field: 'source', reason: 'replace affected target with fixed control' }];
  const verified = await verifyFix({ ...options, allowChanges });
  assert.equal(verified.status, 'target_not_observed');
  assert.equal(verified.candidate.completedTrials, 2);
  assert.equal(verified.candidate.unhealthyTrials, 0);
  assert.deepEqual(JSON.parse(await readFile(verified.metadataPath, 'utf8')), verified);
  const cliArgs = ['verify', options.baseline, '--command', command, '--cwd', cwd, '--allow-change', 'source:fixed control', '--json'];
  assert.equal((await invoke(cliArgs, 0)).status, 'target_not_observed');
  await writeFile(target, unrelated);
  const invalid = await verifyFix({ ...options, allowChanges });
  assert.equal(invalid.status, 'inconclusive');
  assert.equal(invalid.candidate.matchedTrials, 0);
  assert.equal(invalid.candidate.unhealthyTrials, 2);
  assert.equal((await invoke(cliArgs, 2)).status, 'inconclusive');
  await writeFile(target, fixed);
  console.log(JSON.stringify({ cwd, command, baseline: options.baseline, core: 'passed', cli: 'passed', unrelatedErrorGuard: 'passed' }));
}

// The SDK client is a development-only test harness in this checkout. The
// server process below is always the independently installed production CLI.
async function exerciseInstalledMcp(installedDirectory, verification, environment) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'failtrace-package-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(installedDirectory, 'dist', 'cli', 'index.js'), 'mcp', '--cwd', verification.cwd],
    cwd: verification.cwd, env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)), stderr: 'pipe',
  });
  const errors = [];
  const stderr = [];
  client.onerror = (error) => errors.push(error.message);
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  try {
    await client.connect(transport);
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), [
      'failtrace_bisect', 'failtrace_bundle', 'failtrace_compare', 'failtrace_inspect_run',
      'failtrace_minimize', 'failtrace_run', 'failtrace_verify',
    ], 'Installed MCP must register all seven tools');
    const inspectTool = listing.tools.find((tool) => tool.name === 'failtrace_inspect_run');
    assert(inspectTool, 'Installed MCP must expose the inspection tool');
    assert.equal(inspectTool.annotations?.readOnlyHint, true);
    assert.equal(inspectTool.annotations?.destructiveHint, false);
    assert.equal(inspectTool.annotations?.idempotentHint, true);
    assert.equal(inspectTool.annotations?.openWorldHint, false);
    const arguments_ = {
      baseline: verification.baseline, command: verification.command, cwd: verification.cwd,
      allowChanges: [{ field: 'source', reason: 'fixed control' }],
    };
    const valid = await client.callTool({ name: 'failtrace_verify', arguments: arguments_ });
    assert.equal(valid.isError, false);
    assert.equal(valid.structuredContent.status, 'target_not_observed');
    assert.equal(valid.structuredContent.candidate.healthyTrials, 2);
    const page = await client.callTool({ name: 'failtrace_inspect_run', arguments: {
      view: 'trials', run: verification.baseline, filter: 'matched', limit: 1,
    } });
    assert.equal(page.isError, false);
    assert.equal(page.structuredContent.recordedTrials, 2);
    assert.equal(page.structuredContent.matchedTrials, 2);
    assert.deepEqual(page.structuredContent.trials.map((trial) => trial.index), [1]);
    assert.equal(page.structuredContent.nextAfterTrial, 1);
    const outputStart = await client.callTool({ name: 'failtrace_inspect_run', arguments: {
      view: 'output', run: verification.baseline, trial: 1, stream: 'stderr', maxBytes: 6,
    } });
    assert.equal(outputStart.isError, false);
    assert.equal(outputStart.structuredContent.text, 'SMOKE_');
    assert.equal(outputStart.structuredContent.nextOffsetBytes, 6);
    const outputEnd = await client.callTool({ name: 'failtrace_inspect_run', arguments: {
      view: 'output', run: verification.baseline, trial: 1, stream: 'stderr',
      offsetBytes: outputStart.structuredContent.nextOffsetBytes, maxBytes: 64,
    } });
    assert.equal(outputEnd.isError, false);
    assert.equal(outputStart.structuredContent.text + outputEnd.structuredContent.text, 'SMOKE_TARGET\n');
    assert.equal(outputEnd.structuredContent.nextOffsetBytes, null);
    await writeFile(join(verification.cwd, 'target.mjs'), "throw new Error('UNRELATED_SMOKE_FAILURE');\n");
    const invalid = await client.callTool({ name: 'failtrace_verify', arguments: arguments_ });
    assert.equal(invalid.isError, false);
    assert.equal(invalid.structuredContent.status, 'inconclusive');
    assert.equal(invalid.structuredContent.candidate.unhealthyTrials, 2);
    const bounded = await client.callTool({ name: 'failtrace_run', arguments: {
      command: verification.command, repeat: 1, maxOutputBytes: 8, maxTotalOutputBytes: 16,
    } });
    assert.equal(bounded.isError, false);
    assert.equal(bounded.structuredContent.status, 'resource_limited');
    assert.equal(bounded.structuredContent.matchedTrials, 0);
    assert.deepEqual(errors, []);
    assert.equal(stderr.join(''), '', 'MCP stdout must stay protocol-only and stderr should be quiet');
    return { verification: 'passed', inspection: 'passed' };
  } finally {
    await client.close();
  }
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
  await writeFile(join(consumer, 'verify-smoke.mjs'), `await (${exerciseInstalledVerification.toString()})();\n`);
  const verifyOutput = await execute(process.execPath, ['verify-smoke.mjs'], {
    cwd: consumer, env: environment, windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  const verification = JSON.parse(verifyOutput.stdout);
  const mcpChecks = await exerciseInstalledMcp(installedDirectory, verification, environment);
  const help = await npmRun(['exec', '--offline', '--', 'failtrace', '--help'], consumer);
  assert(/\bfailtrace demo\b/.test(help.stdout), 'Installed CLI must advertise the demo');
  const demoOutput = await npmRun(['exec', '--offline', '--', 'failtrace', 'demo', '--json'], consumer);
  const demo = JSON.parse(demoOutput.stdout);
  assert.equal(demo.status, 'completed');
  assert.equal(demo.repetition.statistics.total, 10);
  assert.equal(demo.repetition.statistics.passed, 7);
  assert.equal(demo.repetition.statistics.failed, 3);
  assert.equal(demo.verification.baselineControl.status, 'target_observed');
  assert.equal(demo.verification.baselineControl.matchedTrials, 2);
  assert.equal(demo.verification.baselineControl.unhealthyTrials, 0);
  assert.equal(demo.verification.unrelatedCandidate.status, 'inconclusive');
  assert.equal(demo.verification.unrelatedCandidate.matchedTrials, 0);
  assert.equal(demo.verification.unrelatedCandidate.unrelatedFailureTrials, 2);
  assert.equal(demo.verification.fixedCandidate.status, 'target_not_observed');
  assert.equal(demo.verification.fixedCandidate.matchedTrials, 0);
  assert.equal(demo.verification.fixedCandidate.healthyTrials, 2);
  assert.equal(demo.verification.fixedCandidate.unhealthyTrials, 0);
  await stat(demo.verification.baselineControl.reportPath);
  await stat(demo.verification.unrelatedCandidate.reportPath);
  await stat(demo.verification.fixedCandidate.reportPath);
  assert.equal(demo.reduction.finalVerified, true);
  assert.deepEqual(demo.reduction.minimizedInput, ['BUG']);
  assert((await stat(demo.bundle.directory)).isDirectory());
  const report = {
    package: manifest.name, version: manifest.version, tarball: basename(tarball), sha256,
    checks: { installedCli: 'passed', installedCore: 'passed', productionDependenciesOnly: 'passed', installedDemo: 'passed',
      installedVerifyCore: verification.core, installedVerifyCli: verification.cli, installedVerifyMcp: mcpChecks.verification,
      installedInspectMcp: mcpChecks.inspection, unrelatedErrorGuard: verification.unrelatedErrorGuard },
    core: { total: core.total, failed: core.failed, comparison: core.comparison, inspection: core.inspection },
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

import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import type { BundleResult, ComparisonResult, MinimizeResult, RunSummary } from '../src/core/index.js';
import { cleanupDirectories, cliPath, fixtureCommand, quoteShellArgument, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));

async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}

function invoke(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = `${dirname(process.execPath)}${delimiter}${env[key] ?? ''}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('advanced CLI parsing', () => {
  it('accepts concurrency only as an explicit run option', () => {
    expect(parseArgs(['run', 'test'])).not.toHaveProperty('concurrency');
    expect(parseArgs(['run', 'test', '--concurrency', '1'])).toMatchObject({ concurrency: 1 });
    expect(parseArgs(['run', 'test', '--concurrency=4'])).toMatchObject({ concurrency: 4 });
    expect(parseArgs(['run', 'test', '--concurrency', '9007199254740991'])).toMatchObject({ concurrency: Number.MAX_SAFE_INTEGER });
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
      expect(() => parseArgs(['run', 'test', '--concurrency', value])).toThrow(/concurrency/i);
    }
    expect(() => parseArgs(['run', 'test', '--concurrency'])).toThrow(/requires a value/);
    expect(() => parseArgs(['run', 'test', '--concurrency', '2', '--concurrency', '3'])).toThrow(/once/);
    for (const command of ['demo', 'compare', 'bisect', 'minimize', 'bundle', 'mcp']) {
      expect(() => parseArgs([command, '--concurrency', '2'])).toThrow(/Unexpected option/);
    }
  });

  it('parses run predicates, selected environment names, cwd and JSON', () => {
    expect(parseArgs(['run', 'test', '--exit-code', '0', '--capture-env', 'LANG,TZ', '--cwd', 'project', '--json'])).toEqual({
      kind: 'run', command: 'test', repeat: 10, timeoutMs: 30_000,
      predicate: { kind: 'exit_code', value: 0 }, captureEnv: ['LANG', 'TZ'], cwd: 'project', json: true,
    });
    expect(parseArgs(['run', 'test', '--stderr-regex', 'failure$', '--regex-flags', 'im'])).toMatchObject({ predicate: { kind: 'stderr_regex', pattern: 'failure$', flags: 'im' } });
    expect(parseArgs(['run', 'test', '--stderr-contains=--example'])).toMatchObject({ predicate: { kind: 'stderr_contains', value: '--example' } });
    expect(parseArgs(['run', 'test', '--stdout-contains', ' '])).toMatchObject({ predicate: { kind: 'stdout_contains', value: ' ' } });
  });

  it('parses comparison and search controls', () => {
    expect(parseArgs(['compare', 'a', 'b', '--trial-a', '2', '--trial-b', '3', '--max-lines', '10', '--max-bytes', '20'])).toEqual({ kind: 'compare', runA: 'a', runB: 'b', trialA: 2, trialB: 3, maxLines: 10, maxBytes: 20 });
    expect(parseArgs(['bisect', '--good', 'v1', '--bad', 'HEAD', '--command', 'npm test', '--repeat', '7', '--min-failures', '4'])).toMatchObject({ kind: 'bisect', repeat: 7, minFailures: 4, timeoutMs: 30_000 });
    expect(parseArgs(['minimize', '--input', 'input.json', '--format', 'json', '--command', 'node check.js'])).toMatchObject({ kind: 'minimize', repeat: 1, minFailures: 1, maxEvaluations: 200, format: 'json' });
  });

  it('parses explicit bundle selections and MCP cwd', () => {
    expect(parseArgs(['bundle', 'run-id', '--file', 'a.js', '--file', 'b.json', '--input', 'input', '--command', 'node a.js', '--output', 'out', '--env-file', 'env.json'])).toMatchObject({ kind: 'bundle', run: 'run-id', files: ['a.js', 'b.json'], input: 'input', command: 'node a.js', destination: 'out', envFile: 'env.json' });
    expect(parseArgs(['mcp', '--cwd', 'project'])).toEqual({ kind: 'mcp', cwd: 'project' });
    expect(parseArgs(['bundle', 'run-id', '--include-env', 'A', '--include-env', 'B', '--include-evidence', '--max-bundle-bytes', '2048']))
      .toMatchObject({ kind: 'bundle', includeEnv: ['A', 'B'], includeEvidence: true, maxBundleBytes: 2048 });
  });

  it.each([
    ['run', 'test', '--exit-code', '1', '--stderr-contains', 'failure'],
    ['run', 'test', '--regex-flags', 'i'], ['run', 'test', '--stderr-regex', '['],
    ['run', 'test', '--stdout-regex', 'a', '--regex-flags', 'g'],
    ['run', 'test', '--capture-env', 'A,,B'], ['run', 'test', '--json=false'],
    ['compare'], ['compare', 'a', 'b', 'c'], ['compare', 'a', '--max-bytes', '1048577'],
    ['bisect', '--good', 'v1', '--bad', 'HEAD'],
    ['bisect', '--good', 'v1', '--bad', 'HEAD', '--command', 'test', '--repeat', '1', '--min-failures', '2'],
    ['minimize', '--input', 'in', '--command', 'test', '--format', 'xml'],
    ['minimize', '--input', 'in', '--command', 'test', '--max-evaluations', '1'],
    ['bundle'], ['bundle', 'run-id', '--include-evidence=false'], ['bundle', 'run-id', '--max-bundle-bytes', '0'], ['mcp', '--json'],
  ])('rejects invalid advanced invocation %j', (...args) => expect(() => parseArgs(args)).toThrow());
});

describe('advanced built CLI workflows', () => {
  it('reports concurrent completion order with stable trial labels and saved index order', async () => {
    const cwd = await workspace();
    await cp(fileURLToPath(new URL('./fixtures/adapter-concurrency.mjs', import.meta.url)), join(cwd, 'target.mjs'));
    const output = await invoke(['run', `${quoteShellArgument(process.execPath)} target.mjs`, '--repeat', '2', '--concurrency', '2'], cwd);
    expect(output.code).toBe(1);
    expect(output.stderr).toBe('');
    expect(output.stdout).toContain('completion order; labels are trial indices');
    expect(output.stdout).toMatch(/Concurrency\s+2/);
    expect(output.stdout.indexOf('Trial 02')).toBeLessThan(output.stdout.indexOf('Trial 01'));
    const [id] = await readdir(join(cwd, '.failtrace', 'runs'));
    const run = JSON.parse(await readFile(join(cwd, '.failtrace', 'runs', id!, 'run.json'), 'utf8')) as RunSummary;
    expect(run.concurrency).toBe(2);
    expect(run.trials.map((trial) => trial.index)).toEqual([1, 2]);
    expect(run.statistics).toMatchObject({ passed: 1, failed: 1 });
    expect(await readFile(join(run.artifactDirectory, run.trials[0]!.stdoutPath), 'utf8')).toBe('trial=1\n');
    expect(await readFile(join(run.artifactDirectory, run.trials[1]!.stdoutPath), 'utf8')).toBe('trial=2\n');
  }, 20_000);

  it('emits clean run/comparison JSON and bounded output differences', async () => {
    const cwd = await workspace();
    const runOutput = await invoke(['run', fixtureCommand('alternate'), '--repeat', '4', '--concurrency', '2', '--exit-code', '7', '--json'], cwd);
    expect(runOutput.stderr).toBe('');
    expect(runOutput.code).toBe(1);
    const run = JSON.parse(runOutput.stdout) as RunSummary;
    expect(run.concurrency).toBe(2);
    expect(run.trials.map((trial) => trial.index)).toEqual([1, 2, 3, 4]);
    expect(run.statistics).toMatchObject({ passed: 2, failed: 2 });
    const output = await invoke(['compare', run.id, '--trial-a', '1', '--trial-b', '2', '--max-lines', '4', '--json'], cwd);
    expect(output.code).toBe(0);
    expect(output.stderr).toBe('');
    const comparison = JSON.parse(output.stdout) as ComparisonResult;
    expect(comparison.trialA).toBe(1);
    expect(comparison.trialB).toBe(2);
    expect(comparison.stdout.diff.length).toBeLessThanOrEqual(4);
    expect(comparison.stdout.sha256A).toMatch(/^[a-f0-9]{64}$/);
    expect(comparison.concurrencyChanged).toBe(false);
    const sequentialOutput = await invoke(['run', fixtureCommand('alternate'), '--repeat', '2', '--json'], cwd);
    const sequential = JSON.parse(sequentialOutput.stdout) as RunSummary;
    const changed = await invoke(['compare', run.id, sequential.id], cwd);
    expect(changed.code).toBe(0);
    expect(changed.stdout).toMatch(/Concurrency changed\s+yes/);
  });

  it('reduces the documented JSON demo and bundles the final verified run', async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, 'examples'));
    await cp(fileURLToPath(new URL('../examples/advanced-demo.js', import.meta.url)), join(cwd, 'examples', 'advanced-demo.js'));
    await cp(fileURLToPath(new URL('../examples/advanced-demo-implementation.js', import.meta.url)), join(cwd, 'examples', 'advanced-demo-implementation.js'));
    await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
    await writeFile(join(cwd, 'input.json'), '["a","BUG","b"]');
    const minimized = await invoke(['minimize', '--input', 'input.json', '--format', 'json', '--command', 'node examples/advanced-demo.js', '--stderr-contains', 'BUG reproduced', '--json'], cwd);
    expect(minimized.stderr).toBe('');
    expect(minimized.code).toBe(0);
    const reduction = JSON.parse(minimized.stdout) as MinimizeResult;
    expect(reduction.finalVerified).toBe(true);
    expect(JSON.parse(await readFile(reduction.minimizedPath, 'utf8'))).toEqual(['BUG']);
    expect(await readFile(join(cwd, 'input.json'), 'utf8')).toBe('["a","BUG","b"]');
    const bundled = await invoke(['bundle', reduction.final!.runDirectory, '--file', 'examples/advanced-demo.js', '--file', 'examples/advanced-demo-implementation.js', '--file', 'package.json', '--input', reduction.minimizedPath, '--json'], cwd);
    expect(bundled.code).toBe(0);
    expect(bundled.stderr).toBe('');
    const bundle = JSON.parse(bundled.stdout) as BundleResult;
    expect(await readdir(bundle.directory)).toEqual(expect.arrayContaining(['repro.json', 'repro.mjs', 'repro.sh', 'repro.cmd', 'engine', 'source', 'manifest.json', 'input']));
    expect(await readdir(bundle.directory)).not.toContain('logs');
    expect(bundle.evidenceIncluded).toBe(false);
    const config = JSON.parse(await readFile(bundle.configPath, 'utf8')) as { predicate: unknown };
    expect(config.predicate).toEqual({ kind: 'stderr_contains', value: 'BUG reproduced' });
  });

  it('reports evaluation limits through a structured result and exit 2', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'input.txt'), 'many characters');
    const output = await invoke(['minimize', '--input', 'input.txt', '--command', fixtureCommand('fail'), '--max-evaluations', '2', '--json'], cwd);
    expect(output.code).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({ status: 'limit_reached', finalVerified: true });
  });

  it('reports malformed bundle environment input without creating a bundle', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'env.json'), '[1]');
    const output = await invoke(['bundle', 'unused', '--env-file', 'env.json', '--json'], cwd);
    expect(output.code).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('Environment file');
    expect(await readdir(cwd)).toEqual(['env.json']);
  });
});

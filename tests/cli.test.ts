import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, parseTimeout } from '../src/cli/args.js';
import { cleanupDirectories, cliPath, fixtureCommand, readJson, temporaryDirectory } from './helpers.js';

const directories: string[] = [];

async function workspace(): Promise<string> {
  const path = await temporaryDirectory();
  directories.push(path);
  return path;
}

afterEach(async () => cleanupDirectories(directories));

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI argument parsing', () => {
  it('passes repeatable bisect exit policies to Core', () => {
    expect(parseArgs(['bisect', '--good', 'GOOD', '--bad', 'BAD', '--command', 'node check.mjs',
      '--healthy-exit-code', '0', '--healthy-exit-code', '2', '--inconclusive-exit-code', '125']))
      .toMatchObject({ kind: 'bisect', healthyExitCodes: [0, 2], inconclusiveExitCodes: [125] });
  });

  it('supports help, version, and sensible run defaults', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['run', 'node example.mjs'])).toEqual({
      kind: 'run', command: 'node example.mjs', repeat: 10, timeoutMs: 30_000,
    });
  });

  it('parses explicit trial count and a timeout with units', () => {
    expect(parseArgs(['run', 'node example.mjs', '--repeat', '20', '--timeout', '1.5s'])).toEqual({
      kind: 'run', command: 'node example.mjs', repeat: 20, timeoutMs: 1_500,
    });
    expect(parseArgs(['run', 'node example.mjs', '--repeat=2', '--timeout=400ms'])).toEqual({
      kind: 'run', command: 'node example.mjs', repeat: 2, timeoutMs: 400,
    });
  });

  it.each([
    ['run'], ['run', ''], ['run', 'node', 'example.mjs'],
    ['run', 'node example.mjs', '--unknown'], ['run', 'node example.mjs', '--repeat'],
    ['run', 'node example.mjs', '--timeout'],
  ])('rejects malformed invocation %j', (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', 'one', '9007199254740992'])('rejects repeat %s', (value) => {
    expect(() => parseArgs(['run', 'fixture', '--repeat', value])).toThrow(/repeat/i);
  });

  it.each([
    ['50ms', 50], ['2s', 2_000], ['1.5s', 1_500], ['1.001s', 1_001], ['1m', 60_000], ['0.001s', 1],
  ])('converts timeout %s to milliseconds', (value, expected) => {
    expect(parseTimeout(value)).toBe(expected);
  });

  it.each(['0', '0s', '-1s', 'NaN', 'Infinity', 'ten', '1h', '0.1ms', '0.0001s', '2147483648ms'])('rejects timeout %s', (value) => {
    expect(() => parseTimeout(value)).toThrow(/timeout/i);
  });
});

describe('built CLI', () => {
  it('prints help without creating run artifacts', async () => {
    const cwd = await workspace();
    const result = await runCli(['--help'], cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('FailTrace');
    expect(result.stdout).toContain('--repeat');
    expect(result.stdout).toContain('--timeout');
    expect(result.stderr).toBe('');
    expect(await readdir(cwd)).toEqual([]);
  });

  it('exits zero when all trials pass and displays summary plus artifacts', async () => {
    const cwd = await workspace();
    const result = await runCli(['run', fixtureCommand('pass'), '--repeat', '2'], cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/PASS/);
    expect(result.stdout).toMatch(/Passed\s+2/);
    expect(result.stdout).toMatch(/Failed\s+0/);
    expect(result.stdout).toMatch(/Failure rate\s+0\.0%/);
    expect(result.stdout).toContain('.failtrace');
    expect(result.stderr).toBe('');
    const ids = await readdir(join(cwd, '.failtrace', 'runs'));
    expect(ids).toHaveLength(1);
    expect(await readJson(join(cwd, '.failtrace', 'runs', ids[0]!, 'run.json'))).toMatchObject({
      status: 'completed', statistics: { total: 2, passed: 2, failed: 0 },
    });
  });

  it('exits one for reproduced target failures and prints the failure rate', async () => {
    const result = await runCli(['run', fixtureCommand('alternate'), '--repeat', '4'], await workspace());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Passed\s+2/);
    expect(result.stdout).toMatch(/Failed\s+2/);
    expect(result.stdout).toMatch(/Failure rate\s+50\.0%/);
    expect(result.stdout).toMatch(/Failure reproduced/i);
    expect(result.stderr).toBe('');
  });

  it('exits two for invalid options and gives an actionable error', async () => {
    const cwd = await workspace();
    const result = await runCli(['run', fixtureCommand('pass'), '--repeat', '-1'], cwd);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/repeat/i);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('reports a timed-out target and exits one', async () => {
    const result = await runCli(['run', fixtureCommand('hang'), '--repeat', '1', '--timeout', '100ms'], await workspace());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/TIMEOUT|TIMED.OUT/i);
    expect(result.stdout).toMatch(/Failed\s+1/);
  }, 10_000);
});

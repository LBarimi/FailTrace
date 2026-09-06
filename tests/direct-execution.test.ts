import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { compareRuns, createBundle, loadRun, minimizeFailure, runTrials, validateRunOptions, verifyFix } from '../src/core/index.js';
import { bindInputArguments, sameCommand, validateCommand } from '../src/core/command.js';
import { parseArgs } from '../src/cli/args.js';
import { cleanupDirectories, cliPath, quoteShellArgument, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
async function workspace(): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  return cwd;
}

describe('explicit executable arguments', () => {
  it('preserves shell mode unless an argument array is supplied, including []', () => {
    expect(sameCommand({ command: 'node' }, { command: 'node', args: [] })).toBe(false);
    expect(parseArgs(['run', '--exec', 'node'])).toMatchObject({ command: 'node', args: [] });
    expect(parseArgs(['run', 'node check.mjs'])).not.toHaveProperty('args');
    expect(() => parseArgs(['run', 'node check.mjs', '--exec', 'node'])).toThrow(/do not combine/);
    expect(() => parseArgs(['run', '--arg', 'check.mjs'])).toThrow(/requires --exec/);
    expect(() => parseArgs(['verify', 'baseline', '--command', 'node check.mjs', '--exec', 'node'])).toThrow(/do not combine/);
    expect(bindInputArguments(['{input}', '--file={input}', 'prefix{input}'], 'a b&c')).toEqual(['a b&c', '--file={input}', 'prefix{input}']);
  });

  it('bounds argument bytes, count, types and null bytes before creating artifacts', async () => {
    const cwd = await workspace();
    for (const args of [['bad\0arg'], [1], null, new Array(2), Array.from({ length: 4097 }, () => '')]) {
      expect(() => validateCommand('node', args)).toThrow(/Arguments/);
    }
    expect(() => validateRunOptions({ command: 'node', args: ['a'.repeat(65536)] })).toThrow(/64 KiB/);
    await expect(runTrials({ command: 'node', args: ['bad\0arg'], cwd })).rejects.toThrow(/Arguments/);
  });

  it('passes whitespace, empty values, quotes, Unicode and shell operators literally through Core and CLI', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'show args.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    const values = ['', 'a b', '"quoted"', 'back\\slash\\', '한글', '$HOME', '%PATH%', '&& echo injected', '; echo injected', '`whoami`', '--help'];
    const args = ['show args.mjs', ...values];
    const run = await runTrials({ command: process.execPath, args, cwd, repeat: 1 });
    expect(run.status).toBe('completed');
    expect(run.trials[0]?.status).toBe('passed');
    expect(JSON.parse(await readFile(join(run.artifactDirectory, run.trials[0]!.stdoutPath), 'utf8'))).toEqual(values);
    expect((await loadRun(run.artifactDirectory)).args).toEqual(args);
    expect(run.trials[0]?.args).toEqual(args);
    const cli = await execute(process.execPath, [cliPath, 'run', '--exec', process.execPath, ...args.map(arg => `--arg=${arg}`), '--repeat', '1', '--cwd', cwd, '--json'], { windowsHide: true });
    const fromCli = JSON.parse(cli.stdout);
    expect(fromCli.args).toEqual(args);
    expect(JSON.parse(await readFile(join(fromCli.artifactDirectory, fromCli.trials[0].stdoutPath), 'utf8'))).toEqual(values);
  });

  it('snapshots caller arguments before asynchronous work and accounts for many saved arguments', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'show.mjs'), 'console.log(process.argv.length);');
    const args = ['show.mjs', ...Array.from({ length: 4095 }, () => '')];
    const pending = runTrials({ command: process.execPath, args, cwd, repeat: 1 });
    args[0] = 'missing.mjs';
    const run = await pending;
    expect(run.trials[0]?.status).toBe('passed');
    expect(run.args?.[0]).toBe('show.mjs');
    expect(run.trials[0]?.args).toHaveLength(4096);
    expect((await loadRun(run.artifactDirectory)).trials[0]?.args).toHaveLength(4096);
  });

  it('reports direct spawn failures as data and never silently enables a shell for Windows shims', async () => {
    const cwd = await workspace();
    const run = await runTrials({ command: join(cwd, 'missing-executable'), args: [], cwd, repeat: 1 });
    expect(run.trials[0]?.status).toBe('spawn_error');
    if (process.platform === 'win32') {
      await writeFile(join(cwd, 'shim.cmd'), '@echo SHOULD_NOT_RUN\r\n');
      const shim = await runTrials({ command: join(cwd, 'shim.cmd'), args: [], cwd, repeat: 1 });
      expect(shim.trials[0]).toMatchObject({ status: 'spawn_error', error: expect.stringContaining('require shell mode') });
    }
  });

  it('includes arguments and shell mode in comparison and explicit Verify execution authority', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'check.mjs'), 'if(process.argv[2] !== "fixed") { console.error("TARGET"); process.exitCode=1; }');
    const before = await runTrials({ command: process.execPath, args: ['check.mjs', 'bug'], cwd, repeat: 1,
      captureContext: { sourceFiles: ['check.mjs'] }, predicate: { kind: 'stderr_contains', value: 'TARGET' } });
    const blocked = await verifyFix({ baseline: before.artifactDirectory, cwd, command: process.execPath, args: ['check.mjs', 'fixed'] });
    expect(blocked).toMatchObject({ status: 'inconclusive', candidate: null, changes: [{ field: 'command', allowed: false }] });
    const noInheritance = await verifyFix({ baseline: before.artifactDirectory, cwd, command: process.execPath });
    expect(noInheritance).toMatchObject({ status: 'inconclusive', candidate: null, changes: [{ field: 'command', allowed: false }] });
    expect(noInheritance.plan).not.toHaveProperty('args');
    const after = await verifyFix({ baseline: before.artifactDirectory, cwd, command: process.execPath, args: ['check.mjs', 'fixed'],
      allowChanges: [{ field: 'command', reason: 'Select a fixed-mode control.' }] });
    expect(after.status).toBe('target_not_observed');
    expect(after.plan.args).toEqual(['check.mjs', 'fixed']);
    expect((await compareRuns({ runA: before.artifactDirectory, runB: after.candidate!.artifactDirectory })).commandChanged).toBe(true);
    const shell = await runTrials({ command: `${quoteShellArgument(process.execPath)} check.mjs fixed`, cwd, repeat: 1 });
    expect(shell.trials[0]?.status).toBe('passed');
  });

  it('minimizes existing file arguments and relocates them for reviewed bundle replay', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'check input.mjs'), 'import {readFileSync} from "node:fs"; if(readFileSync(process.argv[2],"utf8").includes("BUG")){console.error("TARGET");process.exitCode=1;}');
    await writeFile(join(cwd, 'input.txt'), 'noise\nBUG\nmore noise\n');
    const result = await minimizeFailure({ command: process.execPath, args: ['check input.mjs', '{input}'], cwd,
      input: 'input.txt', format: 'text', predicate: { kind: 'stderr_contains', value: 'TARGET' } });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true, args: ['check input.mjs', '{input}'] });
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('BUG');
    const final = await loadRun(result.final!.runDirectory);
    expect(final.args).toEqual(['check input.mjs', result.final!.candidatePath]);
    await expect(createBundle({ run: final.artifactDirectory, cwd, command: 'node', args: ['check input.mjs', '{input}'] })).rejects.toThrow(/require an explicit input/);
    await expect(createBundle({ run: final.artifactDirectory, cwd, args: final.args! })).rejects.toThrow(/absolute path/);
    const bundle = await createBundle({ run: final.artifactDirectory, cwd, command: 'node', args: ['check input.mjs', '{input}'],
      files: ['check input.mjs'], input: result.minimizedPath });
    const config = JSON.parse(await readFile(bundle.configPath, 'utf8'));
    expect(config.args).toEqual(['check input.mjs', '{input}']);
    try {
      await execute(process.execPath, [join(bundle.directory, 'repro.mjs')], { cwd, windowsHide: true });
      throw new Error('Expected a reproduced target exit.');
    } catch (error) {
      expect(error).toMatchObject({ code: 1, stdout: expect.stringContaining('Target failure reproduced: 1 / 1') });
    }
  });
});

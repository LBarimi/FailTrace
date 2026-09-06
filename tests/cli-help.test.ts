import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { HELP_COMMANDS } from '../src/cli/help.js';
import { cleanupDirectories, cliPath, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));

async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}

function help(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

describe('command-specific CLI help', () => {
  it('keeps help-like option values as target data', () => {
    expect(parseArgs(['run', 'node check.mjs', '--stderr-contains', '-h']))
      .toMatchObject({ kind: 'run', predicate: { kind: 'stderr_contains', value: '-h' } });
    expect(parseArgs(['run', '--exec', 'node', '--arg', '--help']))
      .toMatchObject({ kind: 'run', command: 'node', args: ['--help'] });
    expect(parseArgs(['run', '--exec', 'node', '--arg=--help']))
      .toMatchObject({ kind: 'run', command: 'node', args: ['--help'] });
  });

  it('routes every supported command to help before opening paths or starting the MCP server', async () => {
    const cwd = await workspace();
    for (const command of HELP_COMMANDS) {
      expect(parseArgs([command, '-h'])).toEqual({ kind: 'help', command });
      const result = await help([command, '--help'], cwd);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`FailTrace ${command} -`);
      expect(result.stdout).toContain('Next:');
      expect(result.stdout).not.toContain('Command-specific options:');
    }
    expect(await readdir(cwd)).toEqual([]);
  });

  it('explains candidate wiring and incomplete reductions on the minimize page', async () => {
    const result = await help(['minimize', '--input', 'missing.json', '--help'], await workspace());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--arg "{input}"');
    expect(result.stdout).toContain('FAILTRACE_INPUT_DIR');
    expect(result.stdout).toContain('status and finalVerified');
    expect(result.stdout).toContain('Baseline not_reproduced');
    expect(result.stdout).toContain('source checkout');
    expect(result.stdout).not.toContain('--capture-env');
    expect(result.stdout).not.toContain('--concurrency');
  });

  it('keeps verification prerequisites and inheritance separate from run options', async () => {
    const result = await help(['verify', '--help'], await workspace());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--allow-change');
    expect(result.stdout).toContain('outputLimits');
    expect(result.stdout).toContain('capture a run');
    expect(result.stdout).toContain('inherit baseline');
    expect(result.stdout).toContain('0 target_not_observed, 1 target_observed, 2 inconclusive');
    expect(result.stdout).not.toContain('Failure condition (choose one');
    expect(result.stdout).not.toContain('--max-evaluations');
  });
});

import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bisectRegression } from '../src/core/bisect.js';
import { createBundle } from '../src/core/bundle.js';
import { minimizeFailure } from '../src/core/minimize.js';
import { runTrials } from '../src/core/run-trials.js';
import { cleanupDirectories, readJson, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}

function nodeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const key = Object.keys(environment).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  environment[key] = `${dirname(process.execPath)}${delimiter}${environment[key] ?? ''}`;
  return environment;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd, windowsHide: true, timeout: 10_000 })).stdout.trim();
}

async function replay(path: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupDirectories(directories);
});

describe('Core safety regressions', () => {
  it.runIf(process.platform === 'win32')('unsets selected minimization variables despite differently cased overrides', async () => {
    const cwd = await workspace();
    const input = join(cwd, 'environment.json');
    await writeFile(input, JSON.stringify({ FailTrace_Safety_Keep: 'yes', FailTrace_Safety_Noise: 'noise' }));
    await writeFile(join(cwd, 'check.mjs'), "process.exitCode = process.env.FAILTRACE_SAFETY_KEEP === 'yes' ? 17 : 0;\n");
    const result = await minimizeFailure({
      cwd, input, format: 'env', command: 'node check.mjs',
      env: { ...nodeEnvironment(), FAILTRACE_SAFETY_KEEP: 'yes', failtrace_safety_noise: 'inherited' },
    });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true, minimizedSize: 1 });
    expect(await readJson(result.minimizedPath)).toEqual({ FailTrace_Safety_Keep: 'yes' });
  });

  it('does not allow progress callbacks to turn rejected reductions into accepted ones', async () => {
    const cwd = await workspace();
    const input = join(cwd, 'input.txt');
    await writeFile(input, 'BUG');
    await writeFile(join(cwd, 'check.mjs'), "import { readFileSync } from 'node:fs'; process.exitCode = readFileSync(process.env.FAILTRACE_INPUT, 'utf8') === 'BUG' ? 17 : 0;\n");
    const result = await minimizeFailure({
      cwd, input, format: 'text', command: 'node check.mjs', env: nodeEnvironment(),
      onCandidate: (evaluation) => { evaluation.accepted = true; evaluation.assessment = 'reproduced'; },
    });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true, minimizedSize: 3 });
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('BUG');
    expect(result.evaluations.filter(({ phase }) => phase === 'candidate').every(({ accepted }) => !accepted)).toBe(true);
  });

  it('keeps bisect reset and clean isolated despite inherited Git config overrides', async () => {
    const cwd = await workspace();
    await git(cwd, 'init', '-b', 'main');
    await git(cwd, 'config', 'user.name', 'FailTrace Test');
    await git(cwd, 'config', 'user.email', 'failtrace@example.invalid');
    await git(cwd, 'config', 'core.autocrlf', 'false');
    await writeFile(join(cwd, '.gitignore'), '.failtrace/\n');
    await writeFile(join(cwd, 'check.mjs'), "import { readFileSync } from 'node:fs'; process.exitCode = readFileSync('state.txt', 'utf8') === 'bad' ? 17 : 0;\n");
    await writeFile(join(cwd, 'state.txt'), 'good');
    await git(cwd, 'add', '.');
    await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'good');
    const good = await git(cwd, 'rev-parse', 'HEAD');
    await writeFile(join(cwd, 'state.txt'), 'bad');
    await git(cwd, 'add', '.');
    await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'bad');
    const bad = await git(cwd, 'rev-parse', 'HEAD');
    await writeFile(join(cwd, 'state.txt'), 'uncommitted user edit');
    await writeFile(join(cwd, 'untracked keep.txt'), 'untracked user content');
    const before = await git(cwd, 'status', '--porcelain');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree');
    vi.stubEnv('GIT_CONFIG_VALUE_0', cwd);
    const result = await bisectRegression({ cwd, good, bad, command: 'node check.mjs', repeat: 1, env: nodeEnvironment() });
    vi.unstubAllEnvs();
    expect(await readFile(join(cwd, 'state.txt'), 'utf8')).toBe('uncommitted user edit');
    expect(await readFile(join(cwd, 'untracked keep.txt'), 'utf8')).toBe('untracked user content');
    expect(await git(cwd, 'status', '--porcelain')).toBe(before);
    expect(result).toMatchObject({ status: 'found', firstBad: bad });
    expect(result.cleanupError).toBeUndefined();
  }, 30_000);

  it.each(['file', 'directory'] as const)('clears the other inherited input variable when replaying a copied %s bundle', async (kind) => {
    const cwd = await workspace();
    const source = join(cwd, 'source');
    await mkdir(source);
    const opposite = kind === 'file' ? 'FAILTRACE_INPUT_DIR' : 'FAILTRACE_INPUT';
    const selected = kind === 'file' ? 'FAILTRACE_INPUT' : 'FAILTRACE_INPUT_DIR';
    await writeFile(join(source, 'check.mjs'), `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const input = ${kind === 'file' ? 'process.env.FAILTRACE_INPUT' : "join(process.env.FAILTRACE_INPUT_DIR, 'input.txt')"};
if (process.env.${opposite} === undefined && readFileSync(input, 'utf8') === 'BUG') process.exitCode = 17;
`);
    const input = join(cwd, kind === 'file' ? 'input.txt' : 'input directory');
    if (kind === 'directory') await mkdir(input);
    await writeFile(kind === 'file' ? input : join(input, 'input.txt'), 'BUG');
    const run = await runTrials({
      cwd: source, command: 'node check.mjs', repeat: 1,
      env: { ...nodeEnvironment(), [selected]: input, [opposite]: undefined },
      predicate: { kind: 'exit_code', value: 17 },
    });
    expect(run.statistics.failed).toBe(1);
    const bundle = await createBundle({ run: run.artifactDirectory, cwd, files: ['check.mjs'], input });
    const moved = join(cwd, 'moved bundle');
    await rename(bundle.directory, moved);
    const result = await replay(join(moved, 'repro.mjs'), cwd, { ...nodeEnvironment(), [opposite]: 'inherited stale path' });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Target failure reproduced: 1 / 1');
    expect(await readdir(join(moved, 'replay-artifacts', 'runs'))).toHaveLength(1);
  });
});

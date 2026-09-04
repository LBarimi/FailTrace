import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundle } from '../src/core/bundle.js';
import { runTrials } from '../src/core/run-trials.js';
import { loadRun } from '../src/core/run-reader.js';
import type { RunOptions, RunSummary } from '../src/core/types.js';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
const fixture = fileURLToPath(new URL('./fixtures/bundle-target.mjs', import.meta.url));

function nodeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
  return env;
}

async function runNode(args: string[], cwd: string, env = nodeEnvironment()): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function setup(mode = 'mixed', options: Pick<RunOptions, 'concurrency' | 'repeat' | 'stopWhenDecided'> = {}): Promise<{ root: string; source: string; run: RunSummary }> {
  const root = await temporaryDirectory();
  directories.push(root);
  const source = join(root, 'original project');
  await mkdir(join(source, 'nested'), { recursive: true });
  await cp(fixture, join(source, 'nested', 'target.mjs'));
  const run = await runTrials({
    command: `node nested/target.mjs ${mode}`,
    cwd: source,
    repeat: 2,
    timeoutMs: 5_000,
    env: nodeEnvironment(),
    predicate: { kind: 'stderr_contains', value: 'EXPECTED_BUNDLE_FAILURE' },
    ...options,
  });
  return { root, source, run };
}

describe('self-contained reproduction bundles', () => {
  it('replays after moving the bundle and deleting original source and artifacts', async () => {
    const { root, source, run } = await setup();
    const result = await createBundle({ run: run.id, cwd: source, files: ['nested/target.mjs'], destination: join(root, 'bundle') });
    const configText = await readFile(result.configPath, 'utf8');
    expect(configText).not.toContain(source);
    expect(configText).not.toContain(run.artifactDirectory);
    expect(JSON.parse(configText)).toMatchObject({ command: run.command, repeat: 2, concurrency: 1, timeoutMs: 5_000, predicate: run.predicate });
    const evidence = await readFile(join(result.directory, 'logs', run.trials[1]!.stderrPath), 'utf8');
    expect(evidence).toContain('EXPECTED_BUNDLE_FAILURE');
    expect(await readFile(join(result.directory, 'repro.sh'), 'utf8')).toContain('repro.mjs');
    expect(await readFile(join(result.directory, 'repro.cmd'), 'utf8')).toContain('%~dp0repro.mjs');
    expect((await readdir(join(result.directory, 'engine'))).some((name) => name.endsWith('.ts'))).toBe(false);
    const moved = join(root, 'moved bundle');
    await rename(result.directory, moved);
    await rm(source, { recursive: true, force: true });
    const replay = await runNode([join(moved, 'repro.mjs')], root);
    expect(replay.stderr).toBe('');
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain('Target failure reproduced: 1 / 2');
    const replayIds = await readdir(join(moved, 'replay-artifacts', 'runs'));
    const metadata = JSON.parse(await readFile(join(moved, 'replay-artifacts', 'runs', replayIds[0]!, 'run.json'), 'utf8')) as RunSummary;
    expect(metadata.predicate).toEqual(run.predicate);
    expect(metadata.trials.map((trial) => trial.failureMatched)).toEqual([false, true]);
  });

  it('does not execute when the generated replay module is imported', async () => {
    const { root, run } = await setup();
    const bundle = await createBundle({ run: run.artifactDirectory, cwd: root });
    const importer = join(bundle.directory, 'import-only.mjs');
    await writeFile(importer, 'import "./repro.mjs"; console.log("imported");\n');
    const imported = await runNode([importer], root);
    expect(imported).toMatchObject({ code: 0, stdout: 'imported\n', stderr: '' });
    expect(await readdir(bundle.directory)).not.toContain('replay-artifacts');
  });

  it('preserves opted-in concurrency when executing the bundled engine', async () => {
    const { root, run } = await setup('mixed', { concurrency: 2 });
    const bundle = await createBundle({ run: run.artifactDirectory, cwd: root, files: ['nested/target.mjs'] });
    expect(JSON.parse(await readFile(bundle.configPath, 'utf8')).concurrency).toBe(2);
    expect(await readFile(join(bundle.directory, 'README.md'), 'utf8')).toContain('contention');
    const replay = await runNode([join(bundle.directory, 'repro.mjs')], root);
    expect(replay).toMatchObject({ code: 1, stderr: '' });
    const runs = join(bundle.directory, 'replay-artifacts', 'runs');
    const [id] = await readdir(runs);
    const replayRun = await loadRun(join(runs, id!));
    expect(replayRun.concurrency).toBe(2);
    expect(replayRun.trials.map((trial) => trial.failureMatched)).toEqual([false, true]);
  });

  it('replays the original trial budget after a threshold-stopped source run', async () => {
    const { root, run } = await setup('mixed', { repeat: 5, stopWhenDecided: { minFailures: 1 } });
    expect(run.trials).toHaveLength(2);
    expect(run.decision?.outcome).toBe('reproduced');
    const bundle = await createBundle({ run: run.artifactDirectory, cwd: root, files: ['nested/target.mjs'] });
    expect(JSON.parse(await readFile(bundle.configPath, 'utf8'))).toMatchObject({ repeat: 5, concurrency: 1 });
    const replay = await runNode([join(bundle.directory, 'repro.mjs')], root);
    expect(replay).toMatchObject({ code: 1, stderr: '' });
    const runs = join(bundle.directory, 'replay-artifacts', 'runs');
    const [id] = await readdir(runs);
    const replayRun = await loadRun(join(runs, id!));
    expect(replayRun.requestedTrials).toBe(5);
    expect(replayRun.trials).toHaveLength(5);
    expect(replayRun.decision).toBeUndefined();
  });

  it('executes replay when launched through a symbolic directory alias', async () => {
    const { root, run } = await setup();
    const bundle = await createBundle({ run: run.artifactDirectory, cwd: root, files: ['nested/target.mjs'] });
    const alias = join(root, 'bundle directory alias');
    await symlink(bundle.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const replay = await runNode([join(alias, 'repro.mjs')], root);
    expect(replay.stderr).toBe('');
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain('Target failure reproduced: 1 / 2');
    expect(await readdir(join(bundle.directory, 'replay-artifacts', 'runs'))).toHaveLength(1);
  });

  it('does not mistake an unrelated failing exit for the chosen predicate', async () => {
    const { root, run } = await setup();
    const bundle = await createBundle({ run: join(run.artifactDirectory, 'run.json'), cwd: root, command: 'node nested/target.mjs unrelated', files: ['nested/target.mjs'] });
    const replay = await runNode([join(bundle.directory, 'repro.mjs')], root);
    expect(replay.code).toBe(0);
    expect(replay.stdout).toContain('Target failure reproduced: 0 / 2');
  });

  it.each(['file', 'directory'] as const)('copies selected %s input and points replay at its relocated path', async (kind) => {
    const { root, run } = await setup();
    const input = join(root, kind === 'file' ? 'input.txt' : 'input tree');
    if (kind === 'file') {
      await writeFile(input, 'NEEDLE');
    } else {
      await mkdir(join(input, 'nested'), { recursive: true });
      await writeFile(join(input, 'nested', 'value.txt'), 'NEEDLE');
    }
    const bundle = await createBundle({
      run: run.artifactDirectory,
      cwd: root,
      input,
      files: ['nested/target.mjs'],
      command: `node nested/target.mjs ${kind === 'file' ? 'input' : 'directory'}`,
    });
    await rm(input, { recursive: true, force: true });
    const replay = await runNode([join(bundle.directory, 'repro.mjs')], root);
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain('Target failure reproduced: 2 / 2');
  });

  it('replays explicit environment values and null removals', async () => {
    const { root, run } = await setup();
    const bundle = await createBundle({
      run: run.artifactDirectory,
      cwd: root,
      files: ['nested/target.mjs'],
      command: 'node nested/target.mjs environment',
      env: { BUNDLE_VALUE: 'selected', BUNDLE_UNSET: null },
    });
    const replay = await runNode([join(bundle.directory, 'repro.mjs')], root, { ...nodeEnvironment(), BUNDLE_UNSET: 'inherited' });
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain('Target failure reproduced: 2 / 2');
  });

  it('requires a portable override for recorded absolute paths', async () => {
    const { root, source, run } = await setup();
    await expect(createBundle({ run: run.artifactDirectory, cwd: root, command: `node "${join(source, 'nested', 'target.mjs')}"` })).rejects.toThrow(/portable command override/);
  });

  it.each(['../outside.txt', '/etc/passwd', 'C:\\outside.txt', 'nested/../../outside.txt', 'nested/file:stream', 'nested/NUL'])('rejects unsafe source path %s', async (file) => {
    const { root, run } = await setup();
    await expect(createBundle({ run: run.artifactDirectory, cwd: root, files: [file] })).rejects.toThrow(/relative paths|Unsafe/);
  });

  it('rejects directory symlinks without copying their contents', async () => {
    const { root, source, run } = await setup();
    const external = join(root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'secret.txt'), 'private');
    await symlink(external, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createBundle({ run: run.artifactDirectory, cwd: root, files: ['linked/secret.txt'] })).rejects.toThrow(/symbolic links/);
    await expect(createBundle({ run: run.artifactDirectory, cwd: root, input: join(source, 'linked') })).rejects.toThrow(/symbolic links/);
  });

  it('never overwrites existing destinations', async () => {
    const { root, run } = await setup();
    const destination = join(root, 'existing');
    await mkdir(destination);
    await writeFile(join(destination, 'keep.txt'), 'untouched');
    await expect(createBundle({ run: run.artifactDirectory, cwd: root, destination })).rejects.toThrow();
    expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('untouched');
  });

  it('cancels without publishing a partial bundle', async () => {
    const { root, run } = await setup();
    const controller = new AbortController();
    controller.abort();
    const destination = join(root, 'cancelled');
    await expect(createBundle({ run: run.artifactDirectory, cwd: root, destination, signal: controller.signal })).rejects.toThrow();
    await expect(lstat(destination)).rejects.toThrow();
  });
});

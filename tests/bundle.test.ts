import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundle, type BundleManifest } from '../src/core/bundle.js';
import { runTrials } from '../src/core/run-trials.js';
import { loadRun } from '../src/core/run-reader.js';
import { BundleWriter } from '../src/core/bundle-files.js';
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

async function setup(mode = 'mixed', options: Pick<RunOptions, 'concurrency' | 'repeat' | 'stopWhenDecided' | 'env' | 'captureEnv'> = {}): Promise<{ root: string; source: string; run: RunSummary }> {
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
  it('rejects directory case collisions even when their child filenames differ', async () => {
    const root = await temporaryDirectory();
    directories.push(root);
    const writer = new BundleWriter(root, 1024);
    await writer.text('source/Group/one.js', 'one', 'source');
    await expect(writer.text('source/group/two.js', 'two', 'source')).rejects.toThrow('case-insensitive');
    expect(await readFile(join(root, 'source', 'Group', 'one.js'), 'utf8')).toBe('one');
  });
  it('excludes private evidence by default and inventories the exact shareable content', async () => {
    const privateValue = 'synthetic-private-environment-value';
    const privateLog = 'synthetic-private-output-value';
    const { root, source, run } = await setup('mixed', { captureEnv: ['BUNDLE_PRIVATE'],
      env: { ...nodeEnvironment(), BUNDLE_PRIVATE: privateValue } });
    const originalMetadata = await readFile(join(run.artifactDirectory, 'run.json'));
    const originalOutput = join(run.artifactDirectory, run.trials[0]!.stdoutPath);
    await appendFile(originalOutput, privateLog);
    const bundle = await createBundle({ cwd: root, run: run.artifactDirectory, files: ['nested/target.mjs'] });
    expect(bundle).toMatchObject({ evidenceIncluded: false, environmentKeys: [],
      requiredEnvironment: [{ key: 'BUNDLE_PRIVATE', state: 'set' }] });
    expect(await readdir(bundle.directory)).not.toContain('logs');
    const manifest = JSON.parse(await readFile(bundle.manifestPath, 'utf8')) as BundleManifest;
    expect(manifest.files.length + 1).toBe(bundle.fileCount);
    expect(manifest.files.every((file) => !file.path.includes('\\') && !file.path.startsWith('/'))).toBe(true);
    expect(manifest.files.some((file) => file.category === 'evidence')).toBe(false);
    let contentBytes = 0;
    for (const entry of manifest.files) {
      const content = await readFile(join(bundle.directory, entry.path));
      expect(content.length).toBe(entry.bytes);
      expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
      expect(content.toString()).not.toContain(privateValue);
      expect(content.toString()).not.toContain(privateLog);
      expect(content.toString()).not.toContain(source);
      expect(content.toString()).not.toContain(source.replaceAll('\\', '\\\\'));
      contentBytes += content.length;
    }
    expect(manifest.contentBytes).toBe(contentBytes);
    expect(bundle.totalBytes).toBe(contentBytes + (await readFile(bundle.manifestPath)).length);
    expect(await readFile(join(run.artifactDirectory, 'run.json'))).toEqual(originalMetadata);
    expect(await readFile(originalOutput, 'utf8')).toContain(privateLog);
  });

  it('checks omitted environment prerequisites before executing replay', async () => {
    const { root, run } = await setup('environment', { captureEnv: ['BUNDLE_VALUE', 'BUNDLE_UNSET'],
      env: { ...nodeEnvironment(), BUNDLE_VALUE: 'selected', BUNDLE_UNSET: undefined } });
    const options = { cwd: root, run: run.artifactDirectory, files: ['nested/target.mjs'] };
    const bundle = await createBundle(options);
    const absent = { ...nodeEnvironment(), BUNDLE_VALUE: undefined, BUNDLE_UNSET: undefined };
    const refused = await runNode([join(bundle.directory, 'repro.mjs')], root, absent);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('BUNDLE_VALUE must be set');
    expect(await readdir(bundle.directory)).not.toContain('replay-artifacts');
    expect((await runNode([join(bundle.directory, 'repro.mjs')], root, { ...absent, BUNDLE_VALUE: 'selected' })).code).toBe(1);
  });

  it('includes only selected captured values and preserves an unset prerequisite', async () => {
    const { root, run } = await setup('environment', { captureEnv: ['BUNDLE_VALUE', 'BUNDLE_UNSET'],
      env: { ...nodeEnvironment(), BUNDLE_VALUE: 'selected', BUNDLE_UNSET: undefined } });
    const options = { cwd: root, run: run.artifactDirectory, files: ['nested/target.mjs'] };
    const absent = { ...nodeEnvironment(), BUNDLE_VALUE: undefined, BUNDLE_UNSET: undefined };
    const selected = await createBundle({ ...options, includeEnv: ['BUNDLE_VALUE'] });
    expect(JSON.parse(await readFile(selected.configPath, 'utf8'))).toMatchObject({ schemaVersion: 2,
      environment: { BUNDLE_VALUE: 'selected' }, requiredEnvironment: [{ key: 'BUNDLE_UNSET', state: 'unset' }] });
    expect((await runNode([join(selected.directory, 'repro.mjs')], root, absent)).code).toBe(1);
    const wrongUnset = await runNode([join(selected.directory, 'repro.mjs')], root, { ...absent, BUNDLE_UNSET: 'unwanted' });
    expect(wrongUnset.code).toBe(2);
    expect(wrongUnset.stderr).toContain('BUNDLE_UNSET must be unset');
    await expect(createBundle({ ...options, includeEnv: ['NOT_CAPTURED'] })).rejects.toThrow('explicitly captured');
  });

  it('cleans an incomplete bundle after a cumulative copy limit without modifying originals', async () => {
    const { root, run } = await setup();
    const input = join(root, 'input');
    await mkdir(input);
    await writeFile(join(input, 'one'), 'x'.repeat(700));
    await writeFile(join(input, 'two'), 'y'.repeat(700));
    const destination = join(root, 'too-large');
    await expect(createBundle({ cwd: root, run: run.artifactDirectory, input, destination, maxBundleBytes: 1000 }))
      .rejects.toThrow('maxBundleBytes');
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(input, 'one'), 'utf8')).toBe('x'.repeat(700));
    expect(await readFile(join(input, 'two'), 'utf8')).toBe('y'.repeat(700));
    expect((await loadRun(run.artifactDirectory)).trials).toHaveLength(2);
  });

  it('refuses excessive source selections, invalid budgets and deeply nested inputs', async () => {
    const { root, run } = await setup();
    const options = { cwd: root, run: run.artifactDirectory };
    await expect(createBundle({ ...options, files: Array.from({ length: 10001 }, () => 'target.mjs') })).rejects.toThrow('10000');
    for (const maxBundleBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(createBundle({ ...options, maxBundleBytes })).rejects.toThrow('positive safe integer');
    }
    const input = join(root, 'deep');
    await mkdir(join(input, ...Array<string>(64).fill('a')), { recursive: true });
    const destination = join(root, 'deep-bundle');
    await expect(createBundle({ ...options, input, destination })).rejects.toThrow('64 path levels');
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replays after moving the bundle and deleting original source and artifacts', async () => {
    const { root, source, run } = await setup();
    const result = await createBundle({ run: run.id, cwd: source, files: ['nested/target.mjs'], destination: join(root, 'bundle'), includeEvidence: true });
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

  it.each(['../outside.txt', '/etc/passwd', 'C:\\outside.txt', 'nested/../../outside.txt', 'nested/file:stream', 'nested/NUL', 'nested/control\u0001'])('rejects unsafe source path %s', async (file) => {
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

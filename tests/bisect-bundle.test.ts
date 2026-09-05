import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { bisectRegression } from '../src/core/bisect.js';
import { createBundle } from '../src/core/bundle.js';
import { copyGitSourceFile } from '../src/core/git-source.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory } from './helpers.js';

const exec = promisify(execFile);
const directories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, timeout: 10_000 });
  return stdout.trim();
}

async function setup(): Promise<{ cwd: string; good: string; bad: string; binary: Buffer; badScript: string }> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  await mkdir(join(cwd, 'suite'));
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'FailTrace Integration');
  await git(cwd, 'config', 'user.email', 'integration@example.invalid');
  await git(cwd, 'config', 'core.autocrlf', 'false');
  await writeFile(join(cwd, '.gitignore'), '.failtrace/\n');
  await writeFile(join(cwd, 'suite', 'check.mjs'), 'console.log("healthy");\n');
  const binary = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 256));
  await writeFile(join(cwd, 'suite', 'binary.bin'), binary);
  await writeFile(join(cwd, 'suite', 'executable.sh'), '#!/bin/sh\nexit 7\n');
  await chmod(join(cwd, 'suite', 'executable.sh'), 0o755);
  await git(cwd, 'add', '.');
  await git(cwd, 'update-index', '--chmod=+x', 'suite/executable.sh');
  await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'good');
  const good = await git(cwd, 'rev-parse', 'HEAD');
  const badScript = 'console.log("recorded regression"); process.exitCode = 7;\n';
  await writeFile(join(cwd, 'suite', 'check.mjs'), badScript);
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'bad');
  return { cwd, good, bad: await git(cwd, 'rev-parse', 'HEAD'), binary, badScript };
}

afterEach(async () => cleanupDirectories(directories));

describe('bundles from isolated bisect evidence', () => {
  it('exports recorded source and binary bytes after worktree cleanup and replays independently of dirty checkout', async () => {
    const { cwd, good, bad, binary, badScript } = await setup();
    const bisect = await bisectRegression({
      cwd: join(cwd, 'suite'), good, bad,
      command: `${quoteShellArgument(process.execPath)} check.mjs`, repeat: 1,
    });
    expect(bisect.status).toBe('found');
    const candidate = bisect.candidates.find((item) => item.commit === bisect.firstBad)!;
    expect(candidate.run.source).toMatchObject({ kind: 'git', commit: bad, subdirectory: 'suite' });
    await expect(stat(candidate.run.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(candidate.run.artifactDirectory, 'run.json'), 'utf8')).source)
      .toEqual(candidate.run.source);

    await writeFile(join(cwd, 'suite', 'check.mjs'), 'throw new Error("unrelated dirty source");\n');
    await writeFile(join(cwd, 'suite', 'binary.bin'), 'dirty binary');
    await writeFile(join(cwd, 'untracked.txt'), 'untouched');
    const before = await git(cwd, 'status', '--porcelain');
    const bundle = await createBundle({
      cwd, run: candidate.run.artifactDirectory, command: 'node check.mjs',
      files: ['check.mjs', 'binary.bin', 'executable.sh'],
    });
    expect(await readFile(join(bundle.directory, 'source', 'check.mjs'), 'utf8')).toBe(badScript);
    expect(await readFile(join(bundle.directory, 'source', 'binary.bin'))).toEqual(binary);
    if (process.platform !== 'win32') expect((await stat(join(bundle.directory, 'source', 'executable.sh'))).mode & 0o111).toBe(0o111);
    const configText = await readFile(bundle.configPath, 'utf8');
    expect(JSON.parse(configText).sourceCommit).toBe(bad);
    expect(configText).not.toContain(cwd.replaceAll('\\', '\\\\'));
    expect(configText).not.toContain(candidate.run.cwd.replaceAll('\\', '\\\\'));

    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
    const replay = await exec(process.execPath, [join(bundle.directory, 'repro.mjs')], {
      cwd, env, windowsHide: true, timeout: 10_000,
    }).then(() => { throw new Error('Replay should exit 1 after reproducing the failure.'); },
      (error: unknown) => error as { code: number; stdout: string; stderr: string });
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain('Target failure reproduced: 1 / 1');
    expect(replay.stderr).toBe('');
    expect(await git(cwd, 'status', '--porcelain')).toBe(before);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(bad);
    expect(await readFile(join(cwd, 'untracked.txt'), 'utf8')).toBe('untouched');
    const tooSmall = join(cwd, '.failtrace', 'oversized-git-bundle');
    await expect(createBundle({ cwd, run: candidate.run.metadataPath, command: 'node check.mjs',
      files: ['binary.bin'], destination: tooSmall, maxBundleBytes: 1024 })).rejects.toThrow('maxBundleBytes');
    await expect(stat(tooSmall)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(cwd, 'status', '--porcelain')).toBe(before);
  });

  it('rejects committed symbolic links before creating an output file', async () => {
    const { cwd, good, bad } = await setup();
    await writeFile(join(cwd, 'link-target.txt'), 'check.mjs');
    const object = await git(cwd, 'hash-object', '-w', 'link-target.txt');
    await git(cwd, 'update-index', '--add', '--cacheinfo', `120000,${object},suite/link.mjs`);
    await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'recorded link');
    const linkedCommit = await git(cwd, 'rev-parse', 'HEAD');
    const destination = join(cwd, '.failtrace', 'exported-link.mjs');
    await expect(copyGitSourceFile({ kind: 'git', repository: cwd, commit: linkedCommit, subdirectory: 'suite' }, 'link.mjs', destination))
      .rejects.toThrow('committed regular file');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(good).not.toBe(bad);
  });

  it('rejects mutable revisions, traversing source paths and pre-cancelled export', async () => {
    const { cwd, bad } = await setup();
    const source = { kind: 'git' as const, repository: cwd, commit: bad, subdirectory: 'suite' };
    const destination = join(cwd, '.failtrace', 'export.mjs');
    await expect(copyGitSourceFile({ ...source, commit: 'HEAD' }, 'check.mjs', destination)).rejects.toThrow('immutable commit');
    await expect(copyGitSourceFile({ ...source, subdirectory: '../outside' }, 'check.mjs', destination)).rejects.toThrow('escape');
    await expect(copyGitSourceFile(source, '../check.mjs', destination)).rejects.toThrow('escape');
    await expect(copyGitSourceFile(source, 'check.mjs', destination, AbortSignal.abort())).rejects.toThrow();
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(cwd)).not.toContain('.failtrace');
  });
});

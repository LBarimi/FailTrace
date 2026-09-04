import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { bisectRegression } from '../src/core/bisect.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory, waitForFile } from './helpers.js';

const exec = promisify(execFile);
const directories: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/bisect-command.mjs', import.meta.url));
const command = `${quoteShellArgument(process.execPath)} check.mjs`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, timeout: 10_000 });
  return stdout.trim();
}

async function repository(states: Array<{ failures: number; hang?: boolean }>): Promise<{ cwd: string; commits: string[] }> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  await mkdir(join(cwd, 'suite'));
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'FailTrace Test');
  await git(cwd, 'config', 'user.email', 'failtrace@example.invalid');
  await git(cwd, 'config', 'core.autocrlf', 'false');
  await copyFile(fixture, join(cwd, 'suite', 'check.mjs'));
  await writeFile(join(cwd, '.gitignore'), '.failtrace/\n');
  const commits: string[] = [];
  for (const state of states) {
    await writeFile(join(cwd, 'suite', 'state.json'), JSON.stringify(state));
    await git(cwd, 'add', '.');
    await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', `failures ${state.failures}${state.hang ? ' hang' : ''}`);
    commits.push(await git(cwd, 'rev-parse', 'HEAD'));
  }
  return { cwd, commits };
}

afterEach(async () => cleanupDirectories(directories));

describe('bisectRegression', () => {
  it('finds the repeated-trial threshold boundary and preserves dirty main checkout state', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 1 }, { failures: 3 }, { failures: 5 }]);
    const dirty = `${await readFile(join(cwd, 'suite', 'check.mjs'), 'utf8')}\n// User edits must survive.\n`;
    await writeFile(join(cwd, 'suite', 'check.mjs'), dirty);
    await writeFile(join(cwd, 'staged.txt'), 'staged content');
    await git(cwd, 'add', 'staged.txt');
    await writeFile(join(cwd, 'untracked.txt'), 'untracked content');
    const before = await git(cwd, 'status', '--porcelain');

    const result = await bisectRegression({
      cwd: join(cwd, 'suite'), command, good: commits[0]!, bad: commits[3]!, repeat: 5, minFailures: 3,
    });
    expect(result.status).toBe('found');
    expect(result.firstBad).toBe(commits[2]);
    expect(result.lastGood).toBe(commits[1]);
    expect(result.scope).toBe('first-parent');
    expect(result.cleanupError).toBeUndefined();
    expect(result.candidates.map((candidate) => candidate.run.statistics.failed)).toEqual([0, 5, 1, 3]);
    for (const candidate of result.candidates) {
      expect(candidate.run.trials).toHaveLength(5);
      expect(candidate.run.cwd).toBe(join(result.artifactDirectory, 'worktree', 'suite'));
      await expect(readFile(join(candidate.run.artifactDirectory, 'run.json'), 'utf8')).resolves.toContain(candidate.run.id);
      await expect(readFile(join(candidate.run.artifactDirectory, candidate.run.trials[0]!.stdoutPath), 'utf8'))
        .resolves.toMatch(/healthy|target signature/);
    }
    expect(JSON.parse(await readFile(join(result.artifactDirectory, 'bisect.json'), 'utf8'))).toEqual(result);
    expect(await git(cwd, 'status', '--porcelain')).toBe(before);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(commits[3]);
    expect(await git(cwd, 'branch', '--show-current')).toBe('main');
    expect(await readFile(join(cwd, 'suite', 'check.mjs'), 'utf8')).toBe(dirty);
    expect(await readFile(join(cwd, 'untracked.txt'), 'utf8')).toBe('untracked content');
    expect((await git(cwd, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
    await expect(readFile(join(result.artifactDirectory, 'worktree', '.git'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports explicit output predicates and resolves named endpoints to immutable commits', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 5 }]);
    await git(cwd, 'tag', 'known-good', commits[0]!);
    const result = await bisectRegression({
      cwd: join(cwd, 'suite'), command, good: 'known-good', bad: 'HEAD', repeat: 1,
      predicate: { kind: 'stdout_contains', value: 'target signature' },
    });
    expect(result.status).toBe('found');
    expect(result.good).toBe(commits[0]);
    expect(result.bad).toBe(commits[1]);
    expect(result.firstBad).toBe(commits[1]);
    expect(result.candidates[1]!.run.trials[0]!.failureMatched).toBe(true);
  });

  it('refuses a supplied good endpoint that reproduces', async () => {
    const { cwd, commits } = await repository([{ failures: 3 }, { failures: 5 }]);
    const result = await bisectRegression({ cwd: join(cwd, 'suite'), command, good: commits[0]!, bad: commits[1]!, repeat: 2 });
    expect(result.status).toBe('inconclusive');
    expect(result.firstBad).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.reason).toContain('good commit reproduces');
  });

  it('refuses a bad endpoint below the configured failure threshold', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 1 }]);
    const result = await bisectRegression({
      cwd: join(cwd, 'suite'), command, good: commits[0]!, bad: commits[1]!, repeat: 3, minFailures: 2,
    });
    expect(result.status).toBe('inconclusive');
    expect(result.firstBad).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.reason).toContain('bad commit does not reproduce');
  });

  it('stops on an inconclusive timed-out middle commit without claiming a culprit', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 0, hang: true }, { failures: 5 }]);
    const result = await bisectRegression({
      cwd: join(cwd, 'suite'), command, good: commits[0]!, bad: commits[2]!, repeat: 1, timeoutMs: 1_000,
    });
    expect(result.status).toBe('inconclusive');
    expect(result.firstBad).toBeNull();
    expect(result.candidates.at(-1)!.assessment).toBe('inconclusive');
    expect(result.candidates.at(-1)!.run.trials[0]!.timedOut).toBe(true);
    expect(result.cleanupError).toBeUndefined();
  });

  it('persists a pre-cancelled report without creating a worktree or evaluating candidates', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 5 }]);
    const controller = new AbortController();
    controller.abort();
    const result = await bisectRegression({
      cwd: join(cwd, 'suite'), command, good: commits[0]!, bad: commits[1]!, signal: controller.signal,
    });
    expect(result.status).toBe('interrupted');
    expect(result.candidates).toHaveLength(0);
    expect(result.endedAt).not.toBeNull();
    expect(JSON.parse(await readFile(join(result.artifactDirectory, 'bisect.json'), 'utf8')).status).toBe('interrupted');
    expect((await git(cwd, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
  });

  it('preserves completed and interrupted candidate evidence when cancelled during a trial', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 0, hang: true }]);
    const marker = join(cwd, 'ready.txt');
    const controller = new AbortController();
    const pending = bisectRegression({
      cwd: join(cwd, 'suite'), command, good: commits[0]!, bad: commits[1]!, repeat: 1,
      env: { FAILTRACE_BISECT_READY: marker }, signal: controller.signal,
    });
    try {
      await waitForFile(marker, 10_000);
    } finally {
      controller.abort();
    }
    const result = await pending;
    expect(result.status).toBe('interrupted');
    expect(result.firstBad).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.assessment).toBe('not_reproduced');
    expect(result.candidates[1]!.run.status).toBe('interrupted');
    expect(result.candidates[1]!.run.trials[0]!.status).toBe('interrupted');
    expect(result.cleanupError).toBeUndefined();
    expect((await git(cwd, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
  });

  it('stops after a callback requests cancellation', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 5 }]);
    const controller = new AbortController();
    const result = await bisectRegression({
      cwd: join(cwd, 'suite'), command, good: commits[0]!, bad: commits[1]!, repeat: 1,
      signal: controller.signal, onCandidate: () => controller.abort(),
    });
    expect(result.status).toBe('interrupted');
    expect(result.candidates).toHaveLength(1);
    expect(result.firstBad).toBeNull();
    expect(result.cleanupError).toBeUndefined();
  });

  it('rejects a merge side-branch boundary outside first-parent scope', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 5 }]);
    await git(cwd, 'checkout', '-b', 'side', commits[0]!);
    await writeFile(join(cwd, 'side.txt'), 'side branch');
    await git(cwd, 'add', 'side.txt');
    await git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', 'side');
    const side = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'checkout', 'main');
    await git(cwd, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'side', '-m', 'merge side');
    const result = await bisectRegression({ cwd: join(cwd, 'suite'), command, good: side, bad: 'HEAD', repeat: 1 });
    expect(result.status).toBe('inconclusive');
    expect(result.reason).toContain('first-parent');
    expect(result.firstBad).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });

  it('records identical endpoints and invalid revisions without claiming a culprit', async () => {
    const { cwd, commits } = await repository([{ failures: 0 }, { failures: 5 }]);
    const same = await bisectRegression({ cwd, command, good: commits[0]!, bad: commits[0]! });
    expect(same.status).toBe('inconclusive');
    expect(same.firstBad).toBeNull();
    const invalid = await bisectRegression({ cwd, command, good: '--not-a-ref', bad: 'HEAD' });
    expect(invalid.status).toBe('error');
    expect(invalid.firstBad).toBeNull();
    expect(invalid.candidates).toHaveLength(0);
    expect(JSON.parse(await readFile(join(invalid.artifactDirectory, 'bisect.json'), 'utf8')).status).toBe('error');
  });

  it.each([0, -1, 4, 1.5, Number.NaN])('rejects an invalid failure threshold %s before touching Git', async (minFailures) => {
    await expect(bisectRegression({ command, good: 'a', bad: 'b', repeat: 3, minFailures })).rejects.toThrow('minFailures');
  });
});

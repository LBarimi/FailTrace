import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { minimizeFailure, type MinimizeEvaluation, type MinimizeResult } from '../src/core/minimize.js';
import type { RunSummary } from '../src/core/types.js';
import { cleanupDirectories, quoteShellArgument, readJson, temporaryDirectory } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/minimize-command.mjs', import.meta.url));
const directories: string[] = [];
const command = (mode: string): string => [process.execPath, fixture, mode].map(quoteShellArgument).join(' ');

async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}

async function inputFile(cwd: string, text: string): Promise<string> {
  const path = join(cwd, 'source input.txt');
  await writeFile(path, text);
  return path;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupDirectories(directories);
});

async function checkEvidence(result: MinimizeResult): Promise<void> {
  expect(await readJson(join(result.artifactDirectory, 'result.json'))).toEqual(result);
  expect(result.evaluations[0]?.phase).toBe('baseline');
  expect(result.evaluations.at(-1)?.phase).toBe('final');
  expect(result.evaluations.length).toBeLessThanOrEqual(result.maxEvaluations);
  for (const evaluation of result.evaluations) {
    const run = await readJson(join(evaluation.runDirectory, 'run.json')) as RunSummary;
    expect(run.command).toBe(result.command);
    if (evaluation.accepted) {
      expect(evaluation.phase).toBe('candidate');
      expect(evaluation.assessment).toBe('reproduced');
      expect(run.status).toBe('completed');
      expect(run.trials.every((trial) => trial.terminationReason === 'exit')).toBe(true);
      expect(run.trials.filter((trial) => trial.failureMatched).length).toBeGreaterThanOrEqual(result.minFailures);
    }
  }
}

describe('minimizeFailure', () => {
  it('minimizes text by lines and characters while preserving source and every evaluation', async () => {
    const cwd = await workspace();
    const original = 'noise\nBUG extra\n';
    const input = await inputFile(cwd, original);
    const observed: MinimizeEvaluation[] = [];
    const result = await minimizeFailure({ command: command('text'), input, format: 'text', cwd, onCandidate: (evaluation) => observed.push(evaluation) });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true, originalSize: original.length, minimizedSize: 3 });
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('BUG');
    expect(await readFile(input, 'utf8')).toBe(original);
    expect(await readFile(result.originalPath, 'utf8')).toBe(original);
    expect(observed).toEqual(result.evaluations);
    await checkEvidence(result);
  }, 30_000);

  it('recursively minimizes JSON object keys and nested array entries while keeping valid JSON', async () => {
    const cwd = await workspace();
    const original = JSON.stringify({ junk: [1, 2], nested: { unused: 'x', items: [{ ignore: 1 }, { break: true, noise: 2 }, 0] } });
    const input = await inputFile(cwd, original);
    const result = await minimizeFailure({ command: command('json'), input, format: 'json', cwd });
    expect(result.status).toBe('completed');
    expect(result.finalVerified).toBe(true);
    expect(await readJson(result.minimizedPath)).toEqual({ nested: { items: [{ break: true }] } });
    expect(result.minimizedSize).toBeLessThan(result.originalSize);
    expect(await readFile(input, 'utf8')).toBe(original);
    expect(await readFile(result.originalPath, 'utf8')).toBe(original);
    for (const evaluation of result.evaluations) {
      await expect(readJson(evaluation.candidatePath)).resolves.toBeDefined();
    }
    await checkEvidence(result);
  }, 30_000);

  it('reduces a file set to its required nested file without changing source files', async () => {
    const cwd = await workspace();
    const input = join(cwd, 'source files');
    await mkdir(join(input, 'nested'), { recursive: true });
    await writeFile(join(input, 'noise.txt'), 'noise');
    await writeFile(join(input, 'nested', 'unused.txt'), 'unused');
    await writeFile(join(input, 'nested', 'bug.txt'), 'BUG');
    const result = await minimizeFailure({ command: command('files'), input, format: 'files', cwd });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true, originalSize: 3, minimizedSize: 1 });
    expect(await readdir(result.minimizedPath)).toEqual(['nested']);
    expect(await readdir(join(result.minimizedPath, 'nested'))).toEqual(['bug.txt']);
    expect(await readFile(join(input, 'noise.txt'), 'utf8')).toBe('noise');
    expect(await readFile(join(input, 'nested', 'unused.txt'), 'utf8')).toBe('unused');
    expect(await readFile(join(result.originalPath, 'nested', 'bug.txt'), 'utf8')).toBe('BUG');
    await checkEvidence(result);
  });

  it('unsets selected variables when removed, including values inherited from the host', async () => {
    const cwd = await workspace();
    const original = '{"FAILTRACE_MINIMIZE_KEEP":"yes","FAILTRACE_MINIMIZE_NOISE":"private value"}';
    const input = await inputFile(cwd, original);
    vi.stubEnv('FAILTRACE_MINIMIZE_KEEP', 'yes');
    vi.stubEnv('FAILTRACE_MINIMIZE_NOISE', 'inherited private value');
    const result = await minimizeFailure({ command: command('env'), input, format: 'env', cwd });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true, originalSize: 2, minimizedSize: 1 });
    expect(await readJson(result.minimizedPath)).toEqual({ FAILTRACE_MINIMIZE_KEEP: 'yes' });
    expect(await readFile(input, 'utf8')).toBe(original);
    expect(await readFile(result.originalPath, 'utf8')).toBe(original);
    const finalRun = await readJson(join(result.final!.runDirectory, 'run.json')) as RunSummary;
    expect(await readJson(join(finalRun.artifactDirectory, finalRun.trials[0]!.stdoutPath))).toEqual({ keepPresent: true, noisePresent: false });
    expect(JSON.stringify(result)).not.toContain('private value');
    await checkEvidence(result);
  });

  it('uses explicit failure predicates and a repeated-trial threshold for every candidate', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'BUGx');
    const result = await minimizeFailure({
      command: command('output'), input, format: 'text', cwd, repeat: 2, minFailures: 2,
      predicate: { kind: 'stdout_contains', value: 'TARGET FAILURE' },
    });
    expect(result.status).toBe('completed');
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('BUG');
    await checkEvidence(result);
  }, 30_000);

  it('keeps a nonreproducing baseline unchanged and performs a final recheck', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'normal');
    const result = await minimizeFailure({ command: command('text'), input, format: 'text', cwd });
    expect(result).toMatchObject({ status: 'not_reproduced', finalVerified: false, minimizedSize: 6 });
    expect(result.evaluations).toHaveLength(2);
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('normal');
    await checkEvidence(result);
  });

  it('reserves the last evaluation for verification when the budget is exhausted', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'noise BUG');
    const result = await minimizeFailure({ command: command('text'), input, format: 'text', cwd, maxEvaluations: 2 });
    expect(result).toMatchObject({ status: 'limit_reached', finalVerified: true });
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations.map(({ phase }) => phase)).toEqual(['baseline', 'final']);
    expect(result.minimizedSize).toBe(result.originalSize);
    await checkEvidence(result);
  });

  it('does not claim verification if an independent final check no longer reproduces', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'BUG');
    const result = await minimizeFailure({ command: command('baseline-only'), input, format: 'text', cwd });
    expect(result).toMatchObject({ status: 'inconclusive', finalVerified: false });
    expect(result.baseline!.assessment).toBe('reproduced');
    expect(result.final!.assessment).toBe('not_reproduced');
    expect(result.evaluations.every(({ accepted }) => !accepted)).toBe(true);
    await checkEvidence(result);
  });

  it('does not accept a candidate whose execution times out', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'AB');
    const result = await minimizeFailure({ command: command('candidate-timeout'), input, format: 'text', cwd, timeoutMs: 750 });
    expect(result).toMatchObject({ status: 'inconclusive', finalVerified: true, minimizedSize: 2 });
    const incomplete = result.evaluations.filter(({ assessment }) => assessment === 'inconclusive');
    expect(incomplete.length).toBeGreaterThan(0);
    expect(incomplete.every(({ accepted }) => !accepted)).toBe(true);
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('AB');
    await checkEvidence(result);
  }, 15_000);

  it('reports a timeout baseline as inconclusive instead of reducing it', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'BUG');
    const result = await minimizeFailure({ command: command('timeout'), input, format: 'text', cwd, timeoutMs: 100 });
    expect(result).toMatchObject({ status: 'inconclusive', finalVerified: false });
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations.every(({ accepted }) => !accepted)).toBe(true);
    await checkEvidence(result);
  });

  it('preserves partial evidence when canceled after an accepted candidate', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'noise\nBUG');
    const controller = new AbortController();
    const result = await minimizeFailure({
      command: command('text'), input, format: 'text', cwd, signal: controller.signal,
      onCandidate: (evaluation) => { if (evaluation.accepted) controller.abort(); },
    });
    expect(result).toMatchObject({ status: 'interrupted', finalVerified: false });
    expect(result.minimizedSize).toBeLessThan(result.originalSize);
    expect(await readFile(input, 'utf8')).toBe('noise\nBUG');
    expect(result.final!.assessment).toBe('inconclusive');
    await checkEvidence(result);
  });

  it('executes no command for a signal that was already aborted', async () => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'BUG');
    const controller = new AbortController();
    controller.abort();
    const result = await minimizeFailure({ command: command('text'), input, format: 'text', cwd, signal: controller.signal });
    expect(result.status).toBe('interrupted');
    expect(result.finalVerified).toBe(false);
    for (const evaluation of result.evaluations) {
      const run = await readJson(join(evaluation.runDirectory, 'run.json')) as RunSummary;
      expect(run.trials).toHaveLength(0);
    }
    await checkEvidence(result);
  });

  it.each([
    { repeat: 0 }, { minFailures: 0 }, { repeat: 1, minFailures: 2 }, { timeoutMs: 0 },
    { maxEvaluations: 1 }, { maxEvaluations: 2.5 }, { maxEvaluations: Number.POSITIVE_INFINITY },
  ])('rejects invalid options %j before creating artifacts', async (override) => {
    const cwd = await workspace();
    const input = await inputFile(cwd, 'BUG');
    await expect(minimizeFailure({ command: command('text'), input, format: 'text', cwd, ...override })).rejects.toThrow();
    expect(await readdir(cwd)).toEqual(['source input.txt']);
  });

  it.each([
    ['json', '{bad json'], ['env', '[]'], ['env', '{"NAME":5}'],
    ['env', '{"BAD-NAME":"x"}'], ['env', '{"FAILTRACE_INPUT":"x"}'],
  ] as const)('rejects malformed %s input', async (format, text) => {
    const cwd = await workspace();
    const input = await inputFile(cwd, text);
    await expect(minimizeFailure({ command: command('text'), input, format, cwd })).rejects.toThrow();
    expect(await readdir(cwd)).toEqual(['source input.txt']);
  });

  it('rejects input/artifact overlap before directory traversal', async () => {
    const cwd = await workspace();
    await expect(minimizeFailure({ command: command('files'), input: cwd, format: 'files', cwd })).rejects.toThrow(/overlap/);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('rejects symbolic links in file sets without traversing their targets', async () => {
    const cwd = await workspace();
    const input = join(cwd, 'inputs');
    const target = join(cwd, 'unrelated');
    await mkdir(input);
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'preserved');
    await symlink(target, join(input, 'external link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(minimizeFailure({ command: command('files'), input, format: 'files', cwd })).rejects.toThrow(/symbolic link/);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('preserved');
    expect(await readdir(cwd)).toEqual(['inputs', 'unrelated']);
  });
});

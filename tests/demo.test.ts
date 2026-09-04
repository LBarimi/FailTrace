import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { runDemo } from '../src/demo/index.js';
import type { DemoResult } from '../src/demo/index.js';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));

async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}

function environment(withNode: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const currentPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = withNode ? `${dirname(process.execPath)}${delimiter}${currentPath}` : '';
  return env;
}

function execute(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('guided demo onboarding', () => {
  it('parses only demo cwd/JSON options and rejects target-command flags', () => {
    expect(parseArgs(['demo'])).toEqual({ kind: 'demo' });
    expect(parseArgs(['demo', '--cwd', 'project', '--json'])).toEqual({ kind: 'demo', cwd: 'project', json: true });
    expect(() => parseArgs(['demo', '--repeat', '20'])).toThrow(/Unexpected option/);
    expect(() => parseArgs(['demo', 'command'])).toThrow(/Unexpected argument/);
  });

  it('runs from a copied installation in an unrelated directory without Node on PATH', async () => {
    const root = await workspace();
    const installed = join(root, 'installed package');
    const cwd = join(root, 'unrelated project');
    await mkdir(installed);
    await mkdir(cwd);
    await writeFile(join(cwd, 'keep.txt'), 'user file stays unchanged');
    const repository = fileURLToPath(new URL('../', import.meta.url));
    await cp(join(repository, 'dist'), join(installed, 'dist'), { recursive: true });
    await cp(join(repository, 'examples'), join(installed, 'examples'), { recursive: true });
    await cp(join(repository, 'LICENSE'), join(installed, 'LICENSE'));
    await writeFile(join(installed, 'package.json'), '{"type":"module"}');

    const output = await execute(join(installed, 'dist', 'cli', 'index.js'), ['demo', '--json'], cwd, environment(false));
    expect(output.stderr).toBe('');
    expect(output.code).toBe(0);
    const demo = JSON.parse(output.stdout) as DemoResult;
    expect(demo.status).toBe('completed');
    expect(demo.repetition?.statistics).toMatchObject({ total: 10, passed: 7, failed: 3, failureRate: 0.3 });
    expect(demo.verification?.baselineControl).toMatchObject({
      status: 'target_observed', completedTrials: 2, matchedTrials: 2, healthyTrials: 2, unhealthyTrials: 0,
      infrastructureTrials: 0, unrelatedFailureTrials: 0, invalidEvidenceTrials: 0,
    });
    expect(demo.verification?.unrelatedCandidate).toMatchObject({
      status: 'inconclusive', completedTrials: 2, matchedTrials: 0, healthyTrials: 0, unhealthyTrials: 2,
      infrastructureTrials: 0, unrelatedFailureTrials: 2, invalidEvidenceTrials: 0,
    });
    expect(demo.verification?.fixedCandidate).toMatchObject({
      status: 'target_not_observed', completedTrials: 2, matchedTrials: 0, healthyTrials: 2, unhealthyTrials: 0,
      infrastructureTrials: 0, unrelatedFailureTrials: 0, invalidEvidenceTrials: 0,
    });
    expect(demo.verification?.baselineRunDirectory).toBeTruthy();
    const baselineMetadata = JSON.parse(await readFile(join(demo.verification!.baselineRunDirectory, 'run.json'), 'utf8')) as {
      environment: { variables: Record<string, string | null> };
    };
    expect(baselineMetadata.environment.variables.FAILTRACE_INPUT).toBe('verification-input.json');
    for (const observation of [demo.verification?.baselineControl, demo.verification?.unrelatedCandidate, demo.verification?.fixedCandidate]) {
      expect(observation?.candidateRunDirectory).toBeTruthy();
      expect((await readFile(observation!.reportPath, 'utf8')).length).toBeGreaterThan(0);
    }
    expect(demo.reduction).toMatchObject({ finalVerified: true, minimizedInput: ['BUG'] });
    expect(demo.reduction?.originalInput).toHaveLength(6);
    const [canonicalCwd, canonicalArtifacts] = await Promise.all([realpath(cwd), realpath(demo.artifactDirectory)]);
    expect(relative(canonicalCwd, canonicalArtifacts).replaceAll('\\', '/')).toMatch(/^\.failtrace\/demos\/[^/]+$/);
    expect(JSON.parse(await readFile(join(demo.artifactDirectory, 'demo.json'), 'utf8'))).toEqual(demo);
    expect(await readFile(join(cwd, 'keep.txt'), 'utf8')).toBe('user file stays unchanged');
    expect((await readdir(cwd)).sort()).toEqual(['.failtrace', 'keep.txt']);
    expect(demo.bundle).toBeDefined();

    const replay = await execute(join(demo.bundle!.directory, 'repro.mjs'), [], root, environment(true));
    expect(replay.code).toBe(1);
    expect(replay.stderr).toBe('');
    expect(replay.stdout).toContain('Target failure reproduced: 1 / 1');
  }, 30_000);

  it('uses --cwd for evidence and prints a clear success summary', async () => {
    const root = await workspace();
    const target = join(root, 'chosen project');
    await mkdir(target);
    const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
    const output = await execute(cli, ['demo', '--cwd', target], root, environment(false));
    expect(output.code).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout).toContain('Demo complete.');
    expect(output.stdout).toContain('7 passed, 3 failed out of 10 trials (30.0%).');
    expect(output.stdout).toContain('Baseline control   target observed — 2/2 target matches.');
    expect(output.stdout).toContain('Unrelated crash    inconclusive — 0 matches, 2 unrelated failures.');
    expect(output.stdout).toContain('Intended fix       target not observed — 0/2 matches, 2 healthy.');
    expect(output.stdout).toContain('this does not prove elimination');
    expect(output.stdout).toContain('-> ["BUG"]');
    expect(output.stdout).toContain('Replay the reduced failure:');
    expect(output.stdout).toContain('Replay exits 1');
    expect(await readdir(root)).toEqual(['chosen project']);
    expect(await readdir(target)).toEqual(['.failtrace']);
  }, 30_000);

  it('preserves a partial trial run on cancellation and never starts later stages', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const stages: string[] = [];
    const demo = await runDemo({
      cwd, signal: controller.signal,
      onProgress: (progress) => {
        stages.push(progress.stage);
        if (progress.trial?.index === 1) controller.abort();
      },
    });
    expect(demo.status).toBe('interrupted');
    expect(demo.endedAt).not.toBeNull();
    expect(demo.repetition?.statistics.total).toBe(1);
    expect(new Set(stages)).toEqual(new Set(['repetition']));
    expect(demo.reduction).toBeUndefined();
    expect(demo.verification).toBeUndefined();
    expect(demo.bundle).toBeUndefined();
    const run = JSON.parse(await readFile(join(demo.repetition!.artifactDirectory, 'run.json'), 'utf8')) as { status: string; trials: unknown[] };
    expect(run.status).toBe('interrupted');
    expect(run.trials).toHaveLength(1);
    expect(JSON.parse(await readFile(join(demo.artifactDirectory, 'demo.json'), 'utf8'))).toEqual(demo);
  });

  it('persists completed verification evidence and stops before later candidates when cancelled', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const demo = await runDemo({ cwd, signal: controller.signal, onProgress: (progress) => {
      if (progress.verification?.candidate === 'baseline_control') controller.abort();
    } });
    expect(demo.status).toBe('interrupted');
    expect(demo.repetition?.statistics).toMatchObject({ total: 10, passed: 7, failed: 3 });
    expect(demo.verification?.baselineControl).toMatchObject({ status: 'target_observed', matchedTrials: 2 });
    expect(demo.verification?.unrelatedCandidate).toBeUndefined();
    expect(demo.verification?.fixedCandidate).toBeUndefined();
    expect((await readFile(demo.verification!.baselineControl!.reportPath, 'utf8')).length).toBeGreaterThan(0);
    expect(demo.reduction).toMatchObject({ finalVerified: true, minimizedInput: ['BUG'] });
    expect(demo.bundle).toBeUndefined();
    expect(JSON.parse(await readFile(join(demo.artifactDirectory, 'demo.json'), 'utf8'))).toEqual(demo);
  });

  it('returns inspectable metadata for a pre-cancelled demo without starting commands', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    controller.abort();
    const demo = await runDemo({ cwd, signal: controller.signal });
    expect(demo.status).toBe('interrupted');
    expect(demo.repetition).toBeUndefined();
    expect(await readdir(demo.artifactDirectory)).toEqual(['demo.json']);
  });
});

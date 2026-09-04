import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessRun, createBundle, minimizeFailure, runTrials, verifyFix } from '../core/index.js';
import type { BundleResult, MinimizeEvaluation, RunStatistics, TrialResult, VerifyResult } from '../core/index.js';
import { writeJsonAtomic } from '../core/artifacts.js';

export type DemoStage = 'repetition' | 'verification' | 'minimization' | 'bundle';
export interface DemoProgress {
  stage: DemoStage;
  trial?: TrialResult;
  evaluation?: MinimizeEvaluation;
  verification?: { candidate: 'baseline_control' | 'unrelated_candidate' | 'fixed_candidate'; observation: DemoVerificationObservation };
}
export interface DemoOptions {
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DemoProgress) => void;
}
export interface DemoResult {
  schemaVersion: 1;
  id: string;
  status: 'running' | 'completed' | 'interrupted' | 'error';
  artifactDirectory: string;
  startedAt: string;
  endedAt: string | null;
  stage: DemoStage;
  repetition?: { artifactDirectory: string; statistics: RunStatistics };
  verification?: {
    baselineRunDirectory: string;
    baselineControl?: DemoVerificationObservation;
    unrelatedCandidate?: DemoVerificationObservation;
    fixedCandidate?: DemoVerificationObservation;
  };
  reduction?: {
    artifactDirectory: string;
    originalInput: string[];
    minimizedInput: unknown;
    minimizedPath: string;
    finalVerified: boolean;
    finalRunDirectory?: string;
  };
  bundle?: BundleResult;
  replayCommand?: string;
  error?: string;
}

export interface DemoVerificationObservation {
  status: VerifyResult['status'];
  completedTrials: number;
  matchedTrials: number;
  healthyTrials: number;
  unhealthyTrials: number;
  infrastructureTrials: number;
  unrelatedFailureTrials: number;
  invalidEvidenceTrials: number;
  reportPath: string;
  candidateRunDirectory?: string;
}

function nodeCommand(script: string): string {
  const executable = process.platform === 'win32'
    ? `"${process.execPath}"`
    : `'${process.execPath.replaceAll("'", "'\\''")}'`;
  return `${executable} ${script}`;
}

function verificationObservation(result: VerifyResult): DemoVerificationObservation {
  const candidate = result.candidate;
  return {
    status: result.status,
    completedTrials: candidate?.completedTrials ?? 0,
    matchedTrials: candidate?.matchedTrials ?? 0,
    healthyTrials: candidate?.healthyTrials ?? 0,
    unhealthyTrials: candidate?.unhealthyTrials ?? 0,
    infrastructureTrials: candidate?.infrastructureTrials ?? 0,
    unrelatedFailureTrials: candidate?.unrelatedFailureTrials ?? 0,
    invalidEvidenceTrials: candidate?.invalidEvidenceTrials ?? 0,
    reportPath: result.metadataPath,
    ...(candidate === null ? {} : { candidateRunDirectory: candidate.artifactDirectory }),
  };
}

/** A guided local example: orchestration stays here, investigation algorithms stay in Core. */
export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  if (!(await stat(cwd)).isDirectory()) throw new Error('Demo working directory must be a directory.');
  for (const directory of [join(cwd, '.failtrace'), join(cwd, '.failtrace', 'demos')]) {
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('Demo artifact directories cannot be symbolic links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(directory, { recursive: true });
  }
  const id = randomUUID();
  const artifactDirectory = join(cwd, '.failtrace', 'demos', id);
  await mkdir(artifactDirectory);
  const projectDirectory = join(artifactDirectory, 'project');
  const metadataPath = join(artifactDirectory, 'demo.json');
  const result: DemoResult = {
    schemaVersion: 1, id, artifactDirectory, status: 'running', stage: 'repetition',
    startedAt: new Date().toISOString(), endedAt: null,
  };
  const persist = (): Promise<void> => writeJsonAtomic(metadataPath, result);
  const step = async (stage: DemoStage): Promise<void> => {
    options.signal?.throwIfAborted();
    result.stage = stage;
    await persist();
    options.onProgress?.({ stage });
    options.signal?.throwIfAborted();
  };
  await persist();
  try {
    options.signal?.throwIfAborted();
    await mkdir(projectDirectory);
    const examples = fileURLToPath(new URL('../../examples/', import.meta.url));
    for (const name of ['flaky-demo.js', 'advanced-demo.js', 'advanced-demo-implementation.js',
      'advanced-demo-unrelated.js', 'advanced-demo-fixed.js', 'advanced-input.json']) {
      await copyFile(join(examples, name), join(projectDirectory, name));
    }
    await writeFile(join(projectDirectory, 'package.json'), '{"type":"module","private":true}\n', { flag: 'wx' });
    const originalInput = JSON.parse(await readFile(join(projectDirectory, 'advanced-input.json'), 'utf8')) as string[];

    await step('repetition');
    const repetition = await runTrials({
      command: nodeCommand('flaky-demo.js'), cwd: projectDirectory, artifactsDir: artifactDirectory,
      repeat: 10, timeoutMs: 5_000, predicate: { kind: 'exit_code', value: 1 },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onTrialComplete: (trial) => options.onProgress?.({ stage: 'repetition', trial }),
    });
    result.repetition = { artifactDirectory: repetition.artifactDirectory, statistics: repetition.statistics };
    options.signal?.throwIfAborted();
    if (assessRun(repetition, 3) !== 'reproduced' || repetition.statistics.passed !== 7 || repetition.statistics.failed !== 3) {
      throw new Error('The deterministic demo did not produce its expected 7 passes and 3 failures. Inspect the saved trial output.');
    }

    await step('minimization');
    const reduction = await minimizeFailure({
      command: nodeCommand('advanced-demo.js'), input: 'advanced-input.json', format: 'json',
      cwd: projectDirectory, repeat: 1, timeoutMs: 5_000, maxEvaluations: 50,
      predicate: { kind: 'stderr_contains', value: 'BUG reproduced' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onCandidate: (evaluation) => options.onProgress?.({ stage: 'minimization', evaluation }),
    });
    const minimizedInput: unknown = JSON.parse(await readFile(reduction.minimizedPath, 'utf8'));
    result.reduction = {
      artifactDirectory: reduction.artifactDirectory, originalInput, minimizedInput,
      minimizedPath: reduction.minimizedPath, finalVerified: reduction.finalVerified,
      ...(reduction.final === undefined ? {} : { finalRunDirectory: reduction.final.runDirectory }),
    };
    options.signal?.throwIfAborted();
    if (reduction.status !== 'completed' || !reduction.finalVerified || !reduction.final || JSON.stringify(minimizedInput) !== '["BUG"]') {
      throw new Error('The demo input was not reduced and verified as ["BUG"]. Inspect the saved minimization evidence.');
    }

    await step('verification');
    const verificationInput = join(projectDirectory, 'verification-input.json');
    await copyFile(reduction.minimizedPath, verificationInput);
    const verifyCommand = nodeCommand('advanced-demo.js');
    const predicate = { kind: 'stderr_contains', value: 'BUG reproduced' } as const;
    const verifyEnvironment = { FAILTRACE_INPUT: 'verification-input.json' };
    const verifyBaseline = await runTrials({
      command: verifyCommand, cwd: projectDirectory, artifactsDir: join(artifactDirectory, 'verification'),
      repeat: 2, timeoutMs: 5_000, predicate, env: verifyEnvironment, captureEnv: ['FAILTRACE_INPUT'],
      captureContext: {
        inputFiles: ['verification-input.json'], setupFiles: ['package.json'],
        sourceFiles: ['advanced-demo-implementation.js', 'advanced-demo.js'],
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    result.verification = { baselineRunDirectory: verifyBaseline.artifactDirectory };
    await persist();
    if (assessRun(verifyBaseline) !== 'reproduced' || !verifyBaseline.context?.stable) {
      throw new Error('The minimized verification input did not produce a stable baseline. Inspect the saved evidence.');
    }
    const verifyOptions = {
      baseline: verifyBaseline.artifactDirectory, command: verifyCommand, cwd: projectDirectory,
      repeat: 2, env: verifyEnvironment, ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const baselineObservation = verificationObservation(await verifyFix(verifyOptions));
    result.verification.baselineControl = baselineObservation;
    await persist();
    options.onProgress?.({ stage: 'verification', verification: { candidate: 'baseline_control', observation: baselineObservation } });
    options.signal?.throwIfAborted();
    if (baselineObservation.status !== 'target_observed' || baselineObservation.matchedTrials !== 2 || baselineObservation.unhealthyTrials !== 0) {
      throw new Error('The unchanged verification control did not reproduce the minimized target twice. Inspect its report.');
    }
    await copyFile(join(projectDirectory, 'advanced-demo-unrelated.js'), join(projectDirectory, 'advanced-demo-implementation.js'));
    const unrelatedObservation = verificationObservation(await verifyFix({ ...verifyOptions,
      allowChanges: [{ field: 'source', reason: 'Demonstrate that a different command failure is not a fix.' }],
    }));
    result.verification.unrelatedCandidate = unrelatedObservation;
    await persist();
    options.onProgress?.({ stage: 'verification', verification: { candidate: 'unrelated_candidate', observation: unrelatedObservation } });
    options.signal?.throwIfAborted();
    if (unrelatedObservation.status !== 'inconclusive' || unrelatedObservation.matchedTrials !== 0 || unrelatedObservation.unrelatedFailureTrials !== 2) {
      throw new Error('The unrelated-error control was not rejected as inconclusive. Inspect its report.');
    }
    await copyFile(join(projectDirectory, 'advanced-demo-fixed.js'), join(projectDirectory, 'advanced-demo-implementation.js'));
    const fixedObservation = verificationObservation(await verifyFix({ ...verifyOptions,
      allowChanges: [{ field: 'source', reason: 'Prevent duplicate checkout work.' }],
    }));
    result.verification.fixedCandidate = fixedObservation;
    await persist();
    options.onProgress?.({ stage: 'verification', verification: { candidate: 'fixed_candidate', observation: fixedObservation } });
    options.signal?.throwIfAborted();
    if (fixedObservation.status !== 'target_not_observed' || fixedObservation.matchedTrials !== 0
      || fixedObservation.healthyTrials !== 2 || fixedObservation.unhealthyTrials !== 0) {
      throw new Error('The fixed verification control did not produce two healthy target-free observations. Inspect its report.');
    }
    // Bundle the affected implementation so replay retains the minimized failure.
    await copyFile(join(examples, 'advanced-demo-implementation.js'), join(projectDirectory, 'advanced-demo-implementation.js'));

    await step('bundle');
    result.bundle = await createBundle({
      run: reduction.final.runDirectory, cwd: projectDirectory,
      files: ['advanced-demo.js', 'advanced-demo-implementation.js', 'package.json'], input: reduction.minimizedPath,
      command: 'node advanced-demo.js', destination: join(artifactDirectory, 'reproduction'),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    result.replayCommand = `node "${join(result.bundle.directory, 'repro.mjs')}"`;
    options.signal?.throwIfAborted();
    result.status = 'completed';
  } catch (error) {
    result.status = options.signal?.aborted ? 'interrupted' : 'error';
    if (result.status === 'error') result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.endedAt = new Date().toISOString();
    await persist();
  }
  return result;
}

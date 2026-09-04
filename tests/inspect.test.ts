import { appendFile, mkdir, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRunEvidence } from '../src/core/inspect.js';
import { aggregateStatistics } from '../src/core/statistics.js';
import type { RunSummary, TrialResult } from '../src/core/types.js';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const directories: string[] = [];

type BufferRead = (
  this: FileHandle, buffer: Buffer, offset: number, length: number, position: number | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

async function workspace(): Promise<string> {
  const directory = await temporaryDirectory();
  directories.push(directory);
  return directory;
}

async function savedRun(cwd: string, count = 45): Promise<RunSummary> {
  const artifactDirectory = join(cwd, '.failtrace', 'runs', 'saved-run');
  const trials: TrialResult[] = [];
  await mkdir(join(artifactDirectory, 'trials'), { recursive: true });
  for (let index = 1; index <= count; index++) {
    const matched = index % 10 === 0;
    const unhealthy = index === 23;
    const relativeDirectory = `trials/${String(index).padStart(3, '0')}`;
    await mkdir(join(artifactDirectory, relativeDirectory));
    await writeFile(join(artifactDirectory, relativeDirectory, 'stdout.txt'), `stdout trial ${index}\n`);
    await writeFile(join(artifactDirectory, relativeDirectory, 'stderr.txt'), `stderr trial ${index}\n`);
    trials.push({
      index, command: 'node marker.mjs', startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.001Z', durationMs: index,
      exitCode: unhealthy ? null : matched ? 7 : 0, signal: null,
      status: unhealthy ? 'timed_out' : matched ? 'failed' : 'passed',
      timedOut: unhealthy, spawningFailed: false,
      terminationReason: unhealthy ? 'timeout' : 'exit', failureMatched: matched,
      stdoutPath: `${relativeDirectory}/stdout.txt`, stderrPath: `${relativeDirectory}/stderr.txt`,
    });
  }
  const summary: RunSummary = {
    schemaVersion: 1, failtraceVersion: 'test', id: 'saved-run', command: 'node marker.mjs', cwd,
    requestedTrials: count, concurrency: 1, timeoutMs: 1000,
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', status: 'completed',
    artifactDirectory, trials, statistics: aggregateStatistics(trials), predicate: { kind: 'exit_code', value: 7 },
  };
  await writeFile(join(artifactDirectory, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function mutateAfterNextHandleRead(path: string, mutation: () => Promise<void>, operation: () => Promise<unknown>): Promise<void> {
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe) as { read: BufferRead };
  const original = prototype.read;
  await probe.close();
  let mutated = false;
  prototype.read = async function (buffer, offset, length, position) {
    const result = await original.call(this, buffer, offset, length, position);
    if (!mutated) {
      mutated = true;
      await mutation();
    }
    return result;
  };
  try {
    await operation();
    throw new Error('Expected inspection to reject changed output.');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/changed while it was being inspected/);
  } finally {
    prototype.read = original;
  }
  expect(mutated).toBe(true);
}

afterEach(async () => cleanupDirectories(directories));

describe('inspectRunEvidence', () => {
  it('pages immutable trial indices and preserves complete aggregate evidence', async () => {
    const cwd = await workspace();
    const run = await savedRun(cwd);
    await writeFile(join(cwd, 'marker.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('marker', 'executed');\n");
    run.trials.reverse();
    await writeFile(join(run.artifactDirectory, 'run.json'), JSON.stringify(run));
    const first = await inspectRunEvidence({ view: 'trials', run: run.artifactDirectory });
    expect(first).toMatchObject({
      view: 'trials', runId: 'saved-run', recordedTrials: 45, requestedTrials: 45,
      matchedTrials: 4, statistics: { total: 45, passed: 40, failed: 5 },
      filter: 'all', afterTrial: 0, limit: 20, nextAfterTrial: 20,
    });
    if (first.view !== 'trials') throw new Error('Expected trial evidence.');
    expect(first.trials.map(({ index }) => index)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const second = await inspectRunEvidence({ view: 'trials', run: run.id, cwd, afterTrial: first.nextAfterTrial!, limit: 20 });
    if (second.view !== 'trials') throw new Error('Expected trial evidence.');
    expect(second.trials.map(({ index }) => index)).toEqual(Array.from({ length: 20 }, (_, index) => index + 21));
    expect(second.nextAfterTrial).toBe(40);
    const final = await inspectRunEvidence({ view: 'trials', run: run.artifactDirectory, afterTrial: second.nextAfterTrial! });
    if (final.view !== 'trials') throw new Error('Expected trial evidence.');
    expect(final.trials.map(({ index }) => index)).toEqual([41, 42, 43, 44, 45]);
    expect(final.nextAfterTrial).toBeNull();
    await expect(stat(join(cwd, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('filters only explicit match states and operationally unhealthy evidence', async () => {
    const run = await savedRun(await workspace());
    // Exit status and predicate match are separate evidence dimensions. Neither
    // combination makes a normally completed trial operationally unhealthy.
    run.trials[0] = { ...run.trials[0]!, exitCode: 0, status: 'passed', failureMatched: true };
    run.trials[1] = { ...run.trials[1]!, exitCode: 7, status: 'failed', failureMatched: false };
    delete run.trials[2]!.failureMatched;
    await writeFile(join(run.artifactDirectory, 'run.json'), JSON.stringify(run));
    const matched = await inspectRunEvidence({
      view: 'trials', run: run.artifactDirectory, filter: 'matched', afterTrial: 10, limit: 2,
    });
    const unhealthy = await inspectRunEvidence({ view: 'trials', run: run.artifactDirectory, filter: 'unhealthy' });
    if (matched.view !== 'trials' || unhealthy.view !== 'trials') throw new Error('Expected trial evidence.');
    expect(matched.trials.map(({ index }) => index)).toEqual([20, 30]);
    expect(matched.nextAfterTrial).toBe(30);
    expect(unhealthy.trials).toEqual([
      expect.objectContaining({ index: 3, unhealthy: true, failureMatched: null }),
      expect.objectContaining({ index: 23, unhealthy: true, status: 'timed_out', failureMatched: false }),
    ]);
    const combinations = await inspectRunEvidence({ view: 'trials', run: run.artifactDirectory, limit: 2 });
    if (combinations.view !== 'trials') throw new Error('Expected trial evidence.');
    expect(combinations.trials.map(({ index, unhealthy, exitCode, failureMatched }) => ({
      index, unhealthy, exitCode, failureMatched,
    }))).toEqual([
      { index: 1, unhealthy: false, exitCode: 0, failureMatched: true },
      { index: 2, unhealthy: false, exitCode: 7, failureMatched: false },
    ]);
    await expect(inspectRunEvidence({ view: 'trials', run: run.artifactDirectory, limit: 41 })).rejects.toThrow(/cannot exceed/);
    await expect(inspectRunEvidence({
      view: 'trials', run: run.artifactDirectory, filter: 'unknown' as 'all',
    })).rejects.toThrow(/filter/);
  });

  it('reads byte-bounded output chunks without accepting arbitrary paths', async () => {
    const run = await savedRun(await workspace(), 1);
    const outputPath = join(run.artifactDirectory, 'trials', '001', 'stdout.txt');
    await writeFile(outputPath, '0123456789');
    const chunk = await inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout', offsetBytes: 2, maxBytes: 4,
    });
    expect(chunk).toEqual({
      view: 'output', runId: 'saved-run', status: 'completed', trial: 1, stream: 'stdout',
      path: 'trials/001/stdout.txt', encoding: 'utf8', totalBytes: 10, offsetBytes: 2,
      bytesRead: 4, text: '2345', nextOffsetBytes: 6, truncated: true,
    });
    if (chunk.view !== 'output') throw new Error('Expected output evidence.');
    const tail = await inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout', offsetBytes: chunk.nextOffsetBytes!, maxBytes: 64,
    });
    expect(tail).toMatchObject({ bytesRead: 4, text: '6789', nextOffsetBytes: null, truncated: true });
    await expect(inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout', offsetBytes: 11,
    })).rejects.toThrow(/offset/);
    await expect(inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout', maxBytes: 64 * 1024 + 1,
    })).rejects.toThrow(/cannot exceed/);

    await writeFile(outputPath, 'x'.repeat(20 * 1024));
    const defaultChunk = await inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout',
    });
    expect(defaultChunk).toMatchObject({
      totalBytes: 20 * 1024, offsetBytes: 0, bytesRead: 16 * 1024,
      nextOffsetBytes: 16 * 1024, truncated: true,
    });

    run.trials[0]!.stdoutPath = '../outside.txt';
    await writeFile(join(run.artifactDirectory, 'run.json'), JSON.stringify(run));
    await expect(inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout',
    })).rejects.toThrow(/canonical/);
  });

  it('rejects symbolic-link redirection before opening saved output', async () => {
    const cwd = await workspace();
    const run = await savedRun(cwd, 1);
    const trialDirectory = join(run.artifactDirectory, 'trials', '001');
    const outside = join(cwd, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'stdout.txt'), 'redirected');
    await writeFile(join(outside, 'stderr.txt'), 'redirected');
    await rm(trialDirectory, { recursive: true });
    await symlink(outside, trialDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout',
    })).rejects.toThrow(/symbolic link/);
  });

  it('rejects a saved output whose size changes after its bounded read', async () => {
    const run = await savedRun(await workspace(), 1);
    const path = join(run.artifactDirectory, 'trials', '001', 'stdout.txt');
    await mutateAfterNextHandleRead(path, () => appendFile(path, 'changed'), () => inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout', maxBytes: 8,
    }));
  });

  it('rejects a same-size replacement after reading the original file handle', async () => {
    const run = await savedRun(await workspace(), 1);
    const path = join(run.artifactDirectory, 'trials', '001', 'stdout.txt');
    const replacement = await readFile(path);
    const original = `${path}.original`;
    await mutateAfterNextHandleRead(path, async () => {
      await rename(path, original);
      await writeFile(path, replacement);
    }, () => inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stdout', maxBytes: 8,
    }));
  });

  it('honors cancellation before reading artifacts', async () => {
    const run = await savedRun(await workspace(), 1);
    await expect(inspectRunEvidence({
      view: 'output', run: run.artifactDirectory, trial: 1, stream: 'stderr', signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(join(run.artifactDirectory, 'trials', '001', 'stderr.txt'), 'utf8')).toBe('stderr trial 1\n');
  });

  it('validates the public Core options object before resolving artifacts', async () => {
    await expect(inspectRunEvidence(null as unknown as Parameters<typeof inspectRunEvidence>[0]))
      .rejects.toThrow(/options/);
    await expect(inspectRunEvidence({ view: 'other', run: 'missing' } as unknown as Parameters<typeof inspectRunEvidence>[0]))
      .rejects.toThrow(/view/);
    await expect(inspectRunEvidence({ view: 'trials', run: '' })).rejects.toThrow(/run ID/);
    await expect(inspectRunEvidence({ view: 'trials', run: 'missing', cwd: '' })).rejects.toThrow(/working directory/);
  });
});

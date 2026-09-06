import * as fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTrials } from '../src/core/index.js';
import { matchesFailure } from '../src/core/predicates.js';
import { SubstringMatcher } from '../src/core/substring-matcher.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory } from './helpers.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const directories: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await cleanupDirectories(directories); });

describe('captured UTF-8 substring evidence', () => {
  it('agrees with fully decoded output at every byte split, including malformed and unfinished UTF-8', () => {
    const output = Buffer.concat([Buffer.from('before-é-😀-終-after'), Buffer.from([0xff, 0xe2, 0x82])]);
    for (const needle of ['é-😀-終', '😀', 'after�', '��', 'missing', '\ud83d', '\ude00']) {
      for (let split = 0; split <= output.length; split++) {
        const matcher = new SubstringMatcher(needle);
        matcher.write(output.subarray(0, split));
        matcher.write(output.subarray(split));
        matcher.end();
        expect(matcher.matched).toBe(output.toString('utf8').includes(needle));
      }
      const matcher = new SubstringMatcher(needle);
      for (const byte of output) matcher.write(Buffer.from([byte]));
      matcher.end();
      expect(matcher.matched).toBe(output.toString('utf8').includes(needle));
    }
  });

  it('evaluates fresh failure and checkpoint output without reopening logs, but rechecks saved output', async () => {
    const cwd = await temporaryDirectory(); directories.push(cwd);
    await writeFile(join(cwd, 'target.mjs'), "process.stdout.write('x'.repeat(1048576) + 'END-é-終'); process.exitCode = 7;");
    const reads = vi.mocked(fs.createReadStream);
    const predicate = { kind: 'stdout_contains' as const, value: 'END-é-終' };
    const run = await runTrials({ cwd, command: `${quoteShellArgument(process.execPath)} target.mjs`, repeat: 2,
      predicate, executionRequirement: { stream: 'stdout', contains: 'END-é-終' } });
    expect(run.trials.every(trial => trial.failureMatched && trial.executionMatched)).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    const trial = run.trials[0]!;
    expect((await readFile(join(run.artifactDirectory, trial.stdoutPath), 'utf8')).endsWith('END-é-終')).toBe(true);
    await writeFile(join(run.artifactDirectory, trial.stdoutPath), 'modified saved evidence');
    expect(await matchesFailure(trial, run.artifactDirectory, predicate)).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('keeps streams and concurrent trials separate', async () => {
    const cwd = await temporaryDirectory(); directories.push(cwd);
    await writeFile(join(cwd, 'target.mjs'), [
      "if (Number(process.env.FAILTRACE_TRIAL_INDEX) % 2) process.stdout.write('TARGET');",
      "else process.stderr.write('TARGET');",
      "process.stderr.write('CHECK_DONE'); process.exitCode = 1;",
    ].join('\n'));
    const run = await runTrials({ cwd, command: `${quoteShellArgument(process.execPath)} target.mjs`, repeat: 4, concurrency: 2,
      predicate: { kind: 'stdout_contains', value: 'TARGET' }, executionRequirement: { stream: 'stderr', contains: 'CHECK_DONE' } });
    expect(run.trials.map(trial => trial.failureMatched)).toEqual([true, false, true, false]);
    expect(run.trials.every(trial => trial.executionMatched)).toBe(true);
  });

  it('does not establish either match when output exceeds its budget after both markers', async () => {
    const cwd = await temporaryDirectory(); directories.push(cwd);
    await writeFile(join(cwd, 'target.mjs'), "process.stdout.write('TARGET CHECK_DONE' + 'x'.repeat(4096));");
    const run = await runTrials({ cwd, command: `${quoteShellArgument(process.execPath)} target.mjs`, repeat: 1, maxOutputBytes: 64,
      predicate: { kind: 'stdout_contains', value: 'TARGET' }, executionRequirement: { stream: 'stdout', contains: 'CHECK_DONE' } });
    expect(run.status).toBe('resource_limited');
    expect(run.trials[0]).toMatchObject({ failureMatched: false, executionMatched: false });
  });
});

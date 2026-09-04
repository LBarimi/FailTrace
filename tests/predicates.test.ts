import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrials } from '../src/core/run-trials.js';
import { assessRun, validatePredicate } from '../src/core/predicates.js';
import type { FailurePredicate } from '../src/core/types.js';
import { cleanupDirectories, quoteShellArgument, readJson, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
async function workspace(): Promise<string> { const cwd = await temporaryDirectory(); directories.push(cwd); return cwd; }
afterEach(async () => cleanupDirectories(directories));
const command = [process.execPath, fileURLToPath(new URL('./fixtures/predicate.mjs', import.meta.url))].map(quoteShellArgument).join(' ');

describe('failure predicates', () => {
  it.each<FailurePredicate>([
    { kind: 'exit_code', value: 7 },
    { kind: 'stdout_contains', value: 'TARGET' },
    { kind: 'stderr_contains', value: 'ERROR' },
    { kind: 'stdout_regex', pattern: '^target$', flags: 'im' },
    { kind: 'stderr_regex', pattern: 'ERR.R' },
  ])('matches $kind and preserves raw evidence', async (predicate) => {
    const summary = await runTrials({ command, repeat: 1, cwd: await workspace(), predicate,
      env: { FAILTRACE_TEST_OUT: 'TARGET\n', FAILTRACE_TEST_ERR: 'ERROR', FAILTRACE_TEST_EXIT: '7' } });
    expect(summary.predicate).toEqual(predicate);
    expect(summary.trials[0]).toMatchObject({ status: 'failed', failureMatched: true, exitCode: 7 });
    expect(assessRun(summary)).toBe('reproduced');
  });

  it('can match a successful exit without hiding its exit code', async () => {
    const summary = await runTrials({ command, repeat: 1, cwd: await workspace(), predicate: { kind: 'exit_code', value: 0 } });
    expect(summary.trials[0]).toMatchObject({ exitCode: 0, status: 'failed', failureMatched: true });
  });

  it('treats an unrelated nonzero exit as a nonmatching target predicate', async () => {
    const summary = await runTrials({ command, repeat: 1, cwd: await workspace(),
      predicate: { kind: 'exit_code', value: 9 }, env: { FAILTRACE_TEST_EXIT: '7' } });
    expect(summary.trials[0]).toMatchObject({ exitCode: 7, status: 'passed', failureMatched: false });
    expect(assessRun(summary)).toBe('not_reproduced');
  });

  it('matches text crossing a stream chunk boundary', async () => {
    const summary = await runTrials({ command, repeat: 1, cwd: await workspace(),
      predicate: { kind: 'stdout_contains', value: 'TARGET' }, env: { FAILTRACE_TEST_MODE: 'boundary' } });
    expect(summary.statistics.failed).toBe(1);
  });

  it.each([
    { kind: 'exit_code', value: -1 }, { kind: 'exit_code', value: 1.5 },
    { kind: 'stdout_contains', value: '' }, { kind: 'stderr_regex', pattern: '[' },
    { kind: 'stderr_regex', pattern: 'x', flags: 'g' }, { kind: 'stderr_regex', pattern: 'x', flags: 'ii' },
  ])('rejects invalid predicate %j', (predicate) => {
    expect(() => validatePredicate(predicate as FailurePredicate)).toThrow();
  });

  it('bounds catastrophic regex evaluation and preserves evidence', async () => {
    const cwd = await workspace();
    await expect(runTrials({ command, repeat: 1, cwd,
      predicate: { kind: 'stdout_regex', pattern: '^(a+)+$' }, env: { FAILTRACE_TEST_MODE: 'redos' },
    })).rejects.toThrow(/evaluation limit/);
    const [id] = await readdir(join(cwd, '.failtrace', 'runs'));
    const summary = await readJson(join(cwd, '.failtrace', 'runs', id!, 'run.json'));
    expect(summary).toMatchObject({ status: 'error', trials: [{ error: expect.stringContaining('evaluation limit') }] });
  });

  it('captures only selected environment values, including missing values', async () => {
    const summary = await runTrials({ command, repeat: 1, cwd: await workspace(),
      env: { FAILTRACE_CAPTURED: 'visible', FAILTRACE_NOT_CAPTURED: 'secret', FAILTRACE_MISSING: undefined },
      captureEnv: ['FAILTRACE_CAPTURED', 'FAILTRACE_MISSING'] });
    expect(summary.environment?.variables).toEqual({ FAILTRACE_CAPTURED: 'visible', FAILTRACE_MISSING: null });
    expect(summary.environment?.nodeVersion).toBe(process.version);
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('does not use interrupted observations or cleanup errors for reduction decisions', async () => {
    const summary = await runTrials({ command, repeat: 1, cwd: await workspace() });
    summary.status = 'interrupted';
    expect(assessRun(summary)).toBe('inconclusive');
    summary.status = 'completed';
    summary.trials[0]!.error = 'cleanup incomplete';
    expect(assessRun(summary)).toBe('inconclusive');
    expect(() => assessRun(summary, 2)).toThrow();
  });
});

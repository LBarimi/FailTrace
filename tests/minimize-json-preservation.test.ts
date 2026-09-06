import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { minimizeFailure } from '../src/core/minimize.js';
import { readMinimizeInput } from '../src/core/minimize-input.js';
import { cleanupDirectories, readJson, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));

async function workspace(input: string): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  await writeFile(join(cwd, 'input.json'), input);
  await writeFile(join(cwd, 'check.mjs'), `
import { readFileSync } from 'node:fs';
const value = JSON.parse(readFileSync(process.env.FAILTRACE_INPUT, 'utf8'));
if (Array.isArray(value) ? value.some(item => typeof item === 'number' && item > 10) : value.a?.length) {
  console.error('TARGET_FAILURE'); process.exitCode = 7;
}
`);
  return cwd;
}

describe('JSON minimization preserves numeric values and input limits', () => {
  it.each(['9007199254740993', '0.10000000000000001', '1e400', '1e-400', '-0'])
  ('rejects lossy numeric token %s before running a target or creating artifacts', async (token) => {
    const input = `[${token},"noise"]`;
    const cwd = await workspace(input);
    await expect(minimizeFailure({ cwd, command: process.execPath, args: ['check.mjs'],
      input: 'input.json', format: 'json' })).rejects.toThrow('--format text');
    expect(await readdir(cwd)).not.toContain('.failtrace');
    expect(await readFile(join(cwd, 'input.json'), 'utf8')).toBe(input);
    // Text mode remains available when exact spelling or a wider numeric range matters.
    expect(await readMinimizeInput(join(cwd, 'input.json'), 'text', cwd)).toMatchObject({ text: input });
  });

  it('accepts equivalent decimal/exponent spelling and ignores numeric text inside strings', async () => {
    const input = '[9007199254740992,1.2300e2,1e20,0.00100,0e999999,"9007199254740993",{"1e400":true}]';
    const cwd = await workspace(input);
    expect(await readMinimizeInput(join(cwd, 'input.json'), 'json', cwd))
      .toMatchObject({ value: JSON.parse(input), text: input });
  });

  it('rejects long significant decimal values without a quadratic trailing-zero scan', async () => {
    const input = '1.' + '0'.repeat(100_000) + '1';
    const cwd = await workspace(input);
    await expect(readMinimizeInput(join(cwd, 'input.json'), 'json', cwd)).rejects.toThrow('--format text');
    expect(await readdir(cwd)).not.toContain('.failtrace');
  });

  it('reduces compact JSON within the original byte allowance without adding formatting overhead', async () => {
    const input = '{"a":[1,2,3]}';
    const cwd = await workspace(input);
    const maxInputBytes = Buffer.byteLength(input);
    const result = await minimizeFailure({ cwd, command: process.execPath, args: ['check.mjs'],
      input: 'input.json', format: 'json', maxInputBytes,
      predicate: { kind: 'stderr_contains', value: 'TARGET_FAILURE' } });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true });
    expect(await readJson(result.minimizedPath)).toEqual({ a: [3] });
    for (const evaluation of result.evaluations) {
      expect((await readFile(evaluation.candidatePath)).length).toBeLessThanOrEqual(maxInputBytes);
    }
    expect(await readFile(join(cwd, 'input.json'), 'utf8')).toBe(input);
  });

  it('preserves the best input and an incomplete report when equivalent numeric encoding exceeds its cap', async () => {
    const input = '[1e20,0]';
    const cwd = await workspace(input);
    const result = await minimizeFailure({ cwd, command: process.execPath, args: ['check.mjs'],
      input: 'input.json', format: 'json', maxInputBytes: Buffer.byteLength(input),
      predicate: { kind: 'stderr_contains', value: 'TARGET_FAILURE' } });
    expect(result).toMatchObject({ status: 'limit_reached', finalVerified: false });
    expect(result.error).toContain('byte input limit');
    expect(result.minimizedPath).toBe(result.originalPath);
    expect(await readFile(result.minimizedPath, 'utf8')).toBe(input);
    expect(result.final).toBeUndefined();
    expect(result.baseline?.assessment).toBe('reproduced');
    expect(await readJson(join(result.artifactDirectory, 'result.json'))).toEqual(result);
  });

  it('keeps compact environment input usable at the original byte cap', async () => {
    const input = '{"KEEP":"yes","NOISE":"x"}';
    const cwd = await workspace(input);
    await writeFile(join(cwd, 'check.mjs'), 'process.exitCode = process.env.KEEP === "yes" ? 7 : 0;\n');
    const result = await minimizeFailure({ cwd, command: process.execPath, args: ['check.mjs'],
      input: 'input.json', format: 'env', maxInputBytes: Buffer.byteLength(input) });
    expect(result).toMatchObject({ status: 'completed', finalVerified: true });
    expect(await readJson(result.minimizedPath)).toEqual({ KEEP: 'yes' });
  });
});

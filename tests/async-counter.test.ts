import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('../examples/workflows/async-counter/', import.meta.url));
const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
async function workspace() {
  const cwd = await temporaryDirectory(); directories.push(cwd);
  for (const file of ['check.mjs', 'counter.mjs', 'schedule.json']) await copyFile(join(fixture, file), join(cwd, file));
  return cwd;
}
async function check(cwd: string, index: number) {
  try { return { ...await execute(process.execPath, ['check.mjs'], { cwd, windowsHide: true, timeout: 5_000,
    env: { ...process.env, FAILTRACE_TRIAL_INDEX: String(index) } }), code: 0 }; }
  catch (error) { if (typeof (error as { code?: unknown }).code !== 'number') throw error;
    return error as { stdout: string; stderr: string; code: number }; }
}

describe('authored asynchronous lost-update controls', () => {
  it('loses an update only for the three predeclared overlapping schedules', async () => {
    const cwd = await workspace();
    for (let index = 1; index <= 6; index++) {
      const result = await check(cwd, index);
      expect(result.code).toBe(index % 2 === 1 ? 7 : 0);
      expect(result.stdout).toContain('COUNTER_CHECK_COMPLETED');
      const data = JSON.parse(result.stdout.split('\n')[0]!);
      expect(data).toMatchObject({ expected: 2, observed: index % 2 === 1 ? 1 : 2 });
      expect(result.stderr.includes('COUNTER_UPDATE_LOST')).toBe(index % 2 === 1);
    }
  });

  it('retains both updates for every schedule after the fix and rejects invalid setup', async () => {
    const cwd = await workspace();
    await copyFile(join(fixture, 'counter-fixed.mjs'), join(cwd, 'counter.mjs'));
    for (let index = 1; index <= 6; index++) {
      const result = await check(cwd, index);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(result.stdout.split('\n')[0]!).observed).toBe(2);
    }
    const original = await readFile(join(cwd, 'schedule.json'), 'utf8');
    await writeFile(join(cwd, 'schedule.json'), '{"schedules":["unknown"]}');
    expect(await check(cwd, 1)).toMatchObject({ code: 125, stdout: '' });
    await writeFile(join(cwd, 'schedule.json'), original);
    expect(await check(cwd, 7)).toMatchObject({ code: 125, stdout: '' });
  });
});

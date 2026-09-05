import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const directory = fileURLToPath(new URL('../examples/workflows/event-import/', import.meta.url));
const temporary: string[] = [];
afterEach(async () => cleanupDirectories(temporary));
async function fixture() {
  const cwd = await temporaryDirectory(); temporary.push(cwd);
  for (const file of ['check.mjs', 'importer.mjs', 'events.json']) await copyFile(join(directory, file), join(cwd, file));
  return cwd;
}
async function check(cwd: string) {
  try { return { ...await execute(process.execPath, ['check.mjs'], { cwd, windowsHide: true, timeout: 5_000 }), code: 0 }; }
  catch (error) { if (typeof (error as { code?: unknown }).code !== 'number') throw error; return error as { code: number; stdout: string; stderr: string }; }
}
describe('authored event import workflow', () => {
  it('detects a lost revision using an independent checker and accepts the corrected importer', async () => {
    const cwd = await fixture();
    const failed = await check(cwd);
    expect(failed.code).toBe(7);
    expect(failed.stdout).toContain('IMPORT_CHECK_COMPLETED');
    expect(failed.stderr).toContain('IMPORT_REVISION_LOST');
    await copyFile(join(directory, 'importer-fixed.mjs'), join(cwd, 'importer.mjs'));
    const fixed = await check(cwd);
    expect(fixed).toMatchObject({ code: 0, stderr: '' });
    expect(fixed.stdout).toContain('IMPORT_CHECK_COMPLETED');
  });

  it('requires two revisions of the same ID and keeps invalid input distinct from the target', async () => {
    const cwd = await fixture();
    const events = JSON.parse(await readFile(join(cwd, 'events.json'), 'utf8')) as { id: string; revision: number }[];
    const pair = events.filter(event => event.id === 'item-c');
    expect(pair).toHaveLength(2);
    await writeFile(join(cwd, 'events.json'), JSON.stringify(pair));
    expect((await check(cwd)).code).toBe(7);
    for (const event of pair) {
      await writeFile(join(cwd, 'events.json'), JSON.stringify([event]));
      expect((await check(cwd)).code).toBe(0);
    }
    await writeFile(join(cwd, 'events.json'), '[{}]');
    const invalid = await check(cwd);
    expect(invalid.code).toBe(125);
    expect(invalid.stderr).toContain('IMPORT_PREPARATION_ERROR');
    expect(invalid.stderr).not.toContain('IMPORT_REVISION_LOST');
    expect(invalid.stdout).not.toContain('IMPORT_CHECK_COMPLETED');
  });
});

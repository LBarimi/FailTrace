import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareRuns, inspectRunEvidence, loadRun } from '../src/core/index.js';
import { MAX_RUN_LOOKUP_ENTRIES } from '../src/core/run-reference.js';
import { cleanupDirectories, cliPath, temporaryDirectory } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/released-runs/0.6.0-completed', import.meta.url));
const older = '2026-01-01T00-00-00-000Z-abcdef01-0000-4000-8000-000000000001';
const newer = '2026-01-02T00-00-00-000Z-abcdef02-0000-4000-8000-000000000002';
const directories: string[] = [];
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, opendir: vi.fn(original.opendir) };
});
afterEach(async () => { vi.restoreAllMocks(); await cleanupDirectories(directories); });
async function workspace(): Promise<string> {
  const cwd = await temporaryDirectory(); directories.push(cwd); return cwd;
}
async function record(cwd: string, id: string): Promise<string> {
  const directory = join(cwd, '.failtrace/runs', id);
  await cp(fixture, directory, { recursive: true });
  const path = join(directory, 'run.json');
  const run = JSON.parse(await readFile(path, 'utf8')) as { id: string };
  run.id = id;
  await writeFile(path, JSON.stringify(run));
  return directory;
}

describe('saved run shorthands', () => {
  it('resolves UUID prefixes and newest-created runs, preserving full IDs in consumers', async () => {
    const cwd = await workspace();
    const first = await record(cwd, older);
    await record(cwd, newer);
    await utimes(first, new Date('2030-01-01'), new Date('2030-01-01'));
    expect((await loadRun('ABCDEF01', cwd)).id).toBe(older);
    expect((await loadRun('latest', cwd)).id).toBe(newer);
    expect((await loadRun('last', cwd)).id).toBe(newer);
    expect((await loadRun(older, cwd)).id).toBe(older);
    expect((await loadRun(join(first, 'run.json'), cwd)).id).toBe(older);
    expect(await compareRuns({ cwd, runA: 'latest' })).toMatchObject({ runA: newer, runB: newer, trialA: 1, trialB: 2 });
    expect(await inspectRunEvidence({ cwd, run: 'abcdef01', view: 'trials' })).toMatchObject({ runId: older });
    const terminal = await promisify(execFile)(process.execPath, [cliPath, 'compare', 'latest', '--cwd', cwd, '--json'], { windowsHide: true });
    expect(JSON.parse(terminal.stdout)).toMatchObject({ runA: newer, runB: newer });
  });

  it('rejects ambiguous prefixes and lists choices instead of guessing', async () => {
    const cwd = await workspace();
    const duplicate = newer.replace('abcdef02', 'abcdef01');
    await record(cwd, older); await record(cwd, duplicate);
    await expect(loadRun('abcdef01', cwd)).rejects.toThrow(`ambiguous (2 matches)`);
    await expect(loadRun('abcdef01', cwd)).rejects.toThrow(older);
    await expect(loadRun('abcdef0', cwd)).rejects.toThrow('at least 8');
    expect((await loadRun(older.slice(25), cwd)).id).toBe(older);
    expect((await loadRun(duplicate, cwd)).id).toBe(duplicate);
  });

  it('keeps lookups local, excludes nested investigations, and reports empty storage', async () => {
    const cwd = await workspace();
    await expect(loadRun('latest', cwd)).rejects.toThrow('No runs found');
    await record(cwd, older);
    const nested = join(cwd, '.failtrace/minimizations/nested');
    await record(nested, newer);
    expect((await loadRun('latest', cwd)).id).toBe(older);
    await expect(loadRun('abcdef02', cwd)).rejects.toThrow('No matching run');
    const other = await workspace();
    await expect(loadRun('abcdef01', other)).rejects.toThrow('No runs found');
    expect((await loadRun(join(nested, '.failtrace/runs', newer), cwd)).id).toBe(newer);
  });

  it('does not fall back from corrupt or incomplete newest evidence', async () => {
    const cwd = await workspace(); await record(cwd, older);
    const latest = await record(cwd, newer);
    await writeFile(join(latest, 'run.json'), '{broken');
    await expect(loadRun('latest', cwd)).rejects.toThrow();
    await writeFile(join(latest, 'run.json'), JSON.stringify({ id: older }));
    await expect(loadRun('latest', cwd)).rejects.toThrow('Selected run ID differs');
    expect((await loadRun('abcdef01', cwd)).id).toBe(older);
  });

  it('uses explicit paths for literal alias names and ignores directory links', async () => {
    const cwd = await workspace(); const first = await record(cwd, older);
    await cp(first, join(cwd, 'latest'), { recursive: true });
    await record(cwd, newer);
    expect((await loadRun('./latest', cwd)).id).toBe(older);
    const linked = '2026-01-03T00-00-00-000Z-abcdef03-0000-4000-8000-000000000003';
    await symlink(first, join(cwd, '.failtrace/runs', linked), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await loadRun('latest', cwd)).id).toBe(newer);
    await expect(loadRun('abcdef03', cwd)).rejects.toThrow('No matching run');
  });

  it('supports cancellation before scanning and refuses redirected shorthand storage', async () => {
    const cwd = await workspace(); const elsewhere = await workspace();
    await record(elsewhere, older);
    await mkdir(join(cwd, '.failtrace'));
    await symlink(join(elsewhere, '.failtrace/runs'), join(cwd, '.failtrace/runs'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(loadRun('latest', cwd)).rejects.toThrow('regular .failtrace/runs');
    await expect(loadRun('latest', cwd, AbortSignal.abort(new Error('cancel lookup')))).rejects.toThrow('cancel lookup');
  });

  it('bounds a directory scan instead of choosing from a partial inventory', async () => {
    const cwd = await workspace(); await record(cwd, older);
    const filesystem = await import('node:fs/promises');
    vi.mocked(filesystem.opendir).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i <= MAX_RUN_LOOKUP_ENTRIES; i++) yield { name: 'unrelated', isDirectory: () => false };
      },
    } as Awaited<ReturnType<typeof filesystem.opendir>>);
    await expect(loadRun('latest', cwd)).rejects.toThrow('100000 entries');
  });
});

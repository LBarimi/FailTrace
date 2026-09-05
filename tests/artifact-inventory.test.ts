import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryArtifacts } from '../src/core/index.js';
import { parseArgs } from '../src/cli/args.js';
import { cleanupDirectories, cliPath, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
async function workspace() { const cwd = await temporaryDirectory(); directories.push(cwd); return cwd; }
async function put(cwd: string, path: string, value: string | object) {
  const destination = join(cwd, '.failtrace', path);
  await mkdir(join(destination, '..'), { recursive: true });
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  await writeFile(destination, text);
  return Buffer.byteLength(text);
}
const complete = { schemaVersion: 1, status: 'completed', endedAt: '2026-01-02T03:04:05.000Z' };

describe('bounded read-only artifact inventory', () => {
  it('does not create storage when there is none', async () => {
    const cwd = await workspace();
    expect(await inventoryArtifacts({ cwd })).toMatchObject({ exists: false, complete: true, bytes: 0, files: 0, entries: [] });
    expect(await readdir(cwd)).toEqual([]);
  });

  it('counts nested investigations once and shows known baseline references without commands or output', async () => {
    const cwd = await workspace();
    const baseline = join(cwd, '.failtrace', 'runs', 'baseline');
    const verification = join(cwd, '.failtrace', 'verifications', 'fix');
    let bytes = await put(cwd, 'runs/baseline/run.json', { ...complete, artifactDirectory: baseline, command: 'DO_NOT_EXECUTE_OR_DISPLAY' });
    bytes += await put(cwd, 'runs/baseline/trials/001/stdout.txt', 'private target output');
    bytes += await put(cwd, 'verifications/fix/verify.json', { ...complete, status: 'target_not_observed',
      baseline: { artifactDirectory: baseline, metadataPath: join(baseline, 'run.json') },
      candidate: { artifactDirectory: join(verification, 'candidate', 'runs', 'candidate') } });
    bytes += await put(cwd, 'verifications/fix/candidate/runs/candidate/run.json', complete);
    bytes += await put(cwd, 'verifications/fix/candidate/runs/candidate/trials/001/stdout.txt', 'OK');
    const before = await readdir(cwd, { recursive: true });
    const result = await inventoryArtifacts({ cwd });
    expect(result).toMatchObject({ complete: true, bytes, files: 5, entries: [
      { path: 'runs/baseline', kind: 'runs', status: 'completed', files: 2, referencedBy: ['verifications/fix'] },
      { path: 'verifications/fix', kind: 'verifications', status: 'target_not_observed', files: 3, references: ['runs/baseline'] },
    ] });
    expect(result.entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(bytes);
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EXECUTE_OR_DISPLAY|private target output/);
    expect(await readdir(cwd, { recursive: true })).toEqual(before);
    expect(await readFile(join(baseline, 'trials/001/stdout.txt'), 'utf8')).toBe('private target output');
    expect((await inventoryArtifacts({ cwd })).snapshot).toBe(result.snapshot);
    await put(cwd, 'runs/baseline/trials/001/stdout.txt', 'modified');
    expect((await inventoryArtifacts({ cwd })).snapshot).not.toBe(result.snapshot);
  });

  it('keeps unknown data and active or incomplete reports visible', async () => {
    const cwd = await workspace();
    await put(cwd, 'notes.txt', 'user-owned note');
    await put(cwd, 'runs/active/run.json', { status: 'running', endedAt: null });
    await put(cwd, 'runs/partial/trials/001/stdout.txt', 'partial output');
    const result = await inventoryArtifacts({ cwd });
    expect(result.complete).toBe(true);
    expect(result.entries).toMatchObject([
      { path: 'notes.txt', kind: 'unknown', status: null, files: 1 },
      { path: 'runs/active', kind: 'runs', status: 'running', endedAt: null },
      { path: 'runs/partial', kind: 'runs', status: null },
    ]);
  });

  it('bounds traversal and distinguishes partial totals', async () => {
    const cwd = await workspace();
    for (let i = 0; i < 20; i++) await put(cwd, `unknown/${i}.txt`, 'bytes');
    const result = await inventoryArtifacts({ cwd, maxEntries: 4 });
    expect(result.scannedEntries).toBe(4);
    expect(result.complete).toBe(false);
    expect(result.files).toBeLessThan(20);
    expect(result.issues).toContain('Entry limit reached; totals are a lower bound.');
  });

  it('never follows a linked subtree and rejects roots reached through links', async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, 'secret.txt'), 'outside private value');
    await mkdir(join(cwd, '.failtrace'));
    await symlink(outside, join(cwd, '.failtrace', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await inventoryArtifacts({ cwd });
    expect(result).toMatchObject({ complete: false, files: 0, bytes: 0 });
    expect(result.issues).toContain('Symbolic links are not followed.');
    await expect(inventoryArtifacts({ cwd, directory: '.failtrace/linked' })).rejects.toThrow(/without symbolic links/);
    await expect(inventoryArtifacts({ cwd, directory: '.failtrace/linked/missing' })).rejects.toThrow(/without symbolic links/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside private value');
  });

  it('fails closed on invalid, relative, missing, and complex metadata references', async () => {
    const cwd = await workspace();
    await put(cwd, 'runs/invalid/run.json', '{');
    await put(cwd, 'runs/relative/run.json', { ...complete, artifactDirectory: './run' });
    await put(cwd, 'runs/invalid-reference/run.json', { ...complete, artifactDirectory: 12 });
    await put(cwd, 'runs/long-reference/run.json', { ...complete, artifactDirectory: 'x'.repeat(4097) });
    await put(cwd, 'verifications/missing/verify.json', { ...complete, baseline: { artifactDirectory: join(cwd, '.failtrace', 'runs', 'absent') } });
    let value: unknown = { metadataPath: 'not-an-authorized-command' };
    for (let i = 0; i < 66; i++) value = { child: value };
    await put(cwd, 'runs/deep/run.json', { ...complete, value });
    const result = await inventoryArtifacts({ cwd });
    expect(result.complete).toBe(false);
    expect(result.entries.every(entry => !entry.complete && entry.issues.length > 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('not-an-authorized-command');
  });

  it('counts external references without disclosing their destinations', async () => {
    const cwd = await workspace();
    const external = await workspace();
    await put(cwd, 'verifications/external/verify.json', { ...complete, baseline: { artifactDirectory: external } });
    const result = await inventoryArtifacts({ cwd });
    expect(result.entries[0]).toMatchObject({ externalReferences: 1, references: [] });
    expect(JSON.stringify(result)).not.toContain(external);
  });

  it('counts an oversized report without reading or inferring its references', async () => {
    const cwd = await workspace();
    await put(cwd, 'runs/oversized/run.json', '');
    const file = await open(join(cwd, '.failtrace/runs/oversized/run.json'), 'r+');
    try { await file.truncate(33 * 1024 * 1024); } finally { await file.close(); }
    const result = await inventoryArtifacts({ cwd });
    expect(result).toMatchObject({ complete: false, files: 1, bytes: 33 * 1024 * 1024, metadataBytesRead: 0 });
    expect(result.entries[0]).toMatchObject({ status: null, complete: false, references: [] });
    expect(result.issues).toContain('Metadata read limit reached; reference information is incomplete.');
  });

  it('bounds nested directories without guessing totals below them', async () => {
    const cwd = await workspace();
    await put(cwd, `unknown/${Array(65).fill('d').join('/')}/output`, 'too deep');
    const result = await inventoryArtifacts({ cwd });
    expect(result).toMatchObject({ complete: false, bytes: 0, files: 0 });
    expect(result.issues).toContain('Directory depth limit reached.');
  });

  it.each([0, -1, 1.5, 100001, NaN])('rejects unbounded entry limits %s', async maxEntries => {
    await expect(inventoryArtifacts({ maxEntries })).rejects.toThrow(/maxEntries/);
  });

  it('honors cancellation before any traversal', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancel inventory'));
    await expect(inventoryArtifacts({ signal: controller.signal })).rejects.toThrow('cancel inventory');
  });

  it('supports a selected storage root in the CLI and never accepts a target command', async () => {
    const cwd = await workspace();
    await put(cwd, 'runs/first/run.json', complete);
    expect(parseArgs(['artifacts', '--directory', '.failtrace', '--max-entries', '100', '--json']))
      .toEqual({ kind: 'artifacts', directory: '.failtrace', maxEntries: 100, json: true });
    expect(() => parseArgs(['artifacts', '--command', 'do not run'])).toThrow(/Unexpected option/);
    expect(() => parseArgs(['artifacts', 'anything'])).toThrow(/Unexpected argument/);
    const result = await promisify(execFile)(process.execPath, [cliPath, 'artifacts', '--directory', relative(cwd, join(cwd, '.failtrace')), '--json'], { cwd, windowsHide: true });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ exists: true, complete: true, entries: [{ path: 'runs/first' }] });
    const text = await promisify(execFile)(process.execPath, [cliPath, 'artifacts'], { cwd, windowsHide: true });
    expect(text.stdout).toContain('Read-only snapshot.');
  });
});

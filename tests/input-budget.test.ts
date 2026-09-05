import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyBoundedFile, readBoundedFile } from '../src/core/bounded-file.js';
import { minimizeFailure } from '../src/core/index.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
async function workspace(): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  await writeFile(join(cwd, 'target.mjs'), "import { readFileSync } from 'node:fs'; process.exitCode = readFileSync(process.env.FAILTRACE_INPUT, 'utf8').includes('BUG') ? 7 : 0;\n");
  return cwd;
}
const command = `${quoteShellArgument(process.execPath)} target.mjs`;
async function retainedInputBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const path of await readdir(directory, { recursive: true })) {
    if (path.replaceAll('\\', '/').split('/').includes('runs')) continue;
    const info = await stat(join(directory, path));
    if (info.isFile() && path !== 'result.json') bytes += info.size;
  }
  return bytes;
}
afterEach(async () => cleanupDirectories(directories));

describe('minimization input storage budget', () => {
  it('preserves the last reproducing input when cumulative copies exhaust the budget', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'input.txt'), 'noise\nBUG');
    const result = await minimizeFailure({ cwd, command, input: 'input.txt', format: 'text', maxCandidateBytes: 22 });
    expect(result).toMatchObject({ status: 'limit_reached', finalVerified: false, minimizedSize: 3, storageLimit: { limitBytes: 22 } });
    expect(result.final).toBeUndefined();
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('BUG');
    expect(await readFile(join(cwd, 'input.txt'), 'utf8')).toBe('noise\nBUG');
    expect(await retainedInputBytes(result.artifactDirectory)).toBeLessThanOrEqual(22);
    expect(JSON.parse(await readFile(join(result.artifactDirectory, 'result.json'), 'utf8'))).toEqual(result);
  });

  it('returns original input without running a target when only its original copy fits', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'input.txt'), 'BUG');
    const result = await minimizeFailure({ cwd, command, input: 'input.txt', format: 'text', maxCandidateBytes: 3 });
    expect(result).toMatchObject({ status: 'limit_reached', finalVerified: false, evaluations: [], minimizedSize: 3 });
    expect(result.minimizedPath).toBe(result.originalPath);
    expect(await readFile(result.minimizedPath, 'utf8')).toBe('BUG');
    expect(await retainedInputBytes(result.artifactDirectory)).toBe(3);
  });

  it('counts every file copy across directory candidates without changing original files', async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, 'inputs'));
    await writeFile(join(cwd, 'inputs', 'a.bin'), 'BUG');
    await writeFile(join(cwd, 'inputs', 'b.bin'), '1234');
    await writeFile(join(cwd, 'target.mjs'), 'process.exitCode = 7;\n');
    const result = await minimizeFailure({ cwd, command, input: 'inputs', format: 'files', maxCandidateBytes: 14 });
    expect(result).toMatchObject({ status: 'limit_reached', finalVerified: false, evaluations: [expect.objectContaining({ phase: 'baseline' })] });
    expect(await retainedInputBytes(result.artifactDirectory)).toBe(14);
    expect(await readFile(join(result.minimizedPath, 'a.bin'), 'utf8')).toBe('BUG');
    expect(await readFile(join(cwd, 'inputs', 'b.bin'), 'utf8')).toBe('1234');
  });

  it('rejects an oversized input and insufficient original-copy allowance before creating an investigation', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'input.txt'), 'BUG');
    await expect(minimizeFailure({ cwd, command, input: 'input.txt', format: 'text', maxInputBytes: 2 })).rejects.toThrow('byte file limit');
    await expect(minimizeFailure({ cwd, command, input: 'input.txt', format: 'text', maxCandidateBytes: 2 })).rejects.toThrow('original input copy');
    expect(await readdir(cwd)).not.toContain('.failtrace');
  });

  it('enforces the input bound across a complete directory, including multiple small files', async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, 'inputs'));
    await writeFile(join(cwd, 'inputs', 'a'), '12');
    await writeFile(join(cwd, 'inputs', 'b'), '34');
    await expect(minimizeFailure({ cwd, command, input: 'inputs', format: 'files', maxInputBytes: 3 })).rejects.toThrow('byte directory limit');
    expect(await readdir(cwd)).not.toContain('.failtrace');
  });

  it('rejects deeply nested JSON before recursive minimization or artifact creation', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'input.json'), '['.repeat(66) + '0' + ']'.repeat(66));
    await expect(minimizeFailure({ cwd, command, input: 'input.json', format: 'json' })).rejects.toThrow('depth limit');
    expect(await readdir(cwd)).not.toContain('.failtrace');
  });
});

describe('bounded file snapshots', () => {
  it('copies exact binary bytes and refuses to overwrite an unrelated destination', async () => {
    const cwd = await workspace();
    const source = join(cwd, 'source.bin');
    const destination = join(cwd, 'copy.bin');
    const bytes = Buffer.from([0, 128, 255]);
    await writeFile(source, bytes);
    expect(await readBoundedFile(source, 3)).toEqual(bytes);
    await copyBoundedFile(source, destination, 3);
    expect(await readFile(destination)).toEqual(bytes);
    await expect(copyBoundedFile(source, destination, 3)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination)).toEqual(bytes);
  });

  it('detects growth after reserving a snapshot and never writes the additional bytes', async () => {
    const cwd = await workspace();
    const source = join(cwd, 'source.bin');
    const destination = join(cwd, 'copy.bin');
    await writeFile(source, '123');
    await expect(copyBoundedFile(source, destination, 3, () => appendFileSync(source, '4567'))).rejects.toThrow('changed');
    expect((await stat(destination)).size).toBeLessThanOrEqual(3);
  });
});

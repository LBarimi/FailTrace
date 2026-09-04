import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCandidate } from '../src/core/minimize-input.js';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));

describe('file candidate copies', () => {
  it('isolates mutations between source and candidate copies and refuses replacement', async () => {
    const cwd = await temporaryDirectory();
    directories.push(cwd);
    const source = join(cwd, 'source');
    await mkdir(source);
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    await writeFile(join(source, 'input.bin'), bytes);
    const first = join(cwd, 'first');
    const second = join(cwd, 'second');
    const candidate = { format: 'files', files: ['input.bin'] } as const;
    await writeCandidate({ ...candidate, files: [...candidate.files] }, first, source);
    await writeCandidate({ ...candidate, files: [...candidate.files] }, second, source);
    await writeFile(join(first, 'input.bin'), 'target mutation');
    expect(await readFile(join(source, 'input.bin'))).toEqual(bytes);
    expect(await readFile(join(second, 'input.bin'))).toEqual(bytes);
    await expect(writeCandidate({ ...candidate, files: [...candidate.files] }, first, source))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(first, 'input.bin'), 'utf8')).toBe('target mutation');
    await writeFile(join(source, 'input.bin'), 'source mutation');
    expect(await readFile(join(second, 'input.bin'))).toEqual(bytes);
  });
});

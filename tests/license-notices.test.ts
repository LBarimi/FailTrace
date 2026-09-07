import { execFile } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/check-licenses.mjs');
const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
async function fixture(): Promise<string> {
  const cwd = await temporaryDirectory(); directories.push(cwd);
  for (const path of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md', 'docs/licenses']) {
    await cp(join(root, path), join(cwd, path), { recursive: true });
  }
  return cwd;
}
const check = (cwd: string) => promisify(execFile)(process.execPath, [script, cwd], { windowsHide: true, timeout: 10000 });

it('accepts complete runtime notices without requiring development licenses', async () => {
  expect((await check(root)).stdout).toContain('Third-party notices checked:');
});

it.each(['new dependency', 'changed version'])('rejects uncovered runtime changes: %s', async change => {
  const cwd = await fixture();
  const file = join(cwd, 'package-lock.json');
  const lock = JSON.parse(await readFile(file, 'utf8')) as { packages: Record<string, { version: string }> };
  if (change === 'new dependency') lock.packages['node_modules/unreviewed-runtime'] = { version: '1.0.0' };
  else lock.packages['node_modules/saxes']!.version = '99.0.0';
  await writeFile(file, JSON.stringify(lock));
  await expect(check(cwd)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Runtime license coverage differs') });
});

it('rejects removal of copyright text from a reviewed notice', async () => {
  const cwd = await fixture();
  const file = join(cwd, 'docs/licenses/saxes.txt');
  await writeFile(file, (await readFile(file, 'utf8')).replace('Copyright (c) Contributors', ''));
  await expect(check(cwd)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('License digest differs: saxes') });
});

it('rejects a missing notice from the public index', async () => {
  const cwd = await fixture();
  const file = join(cwd, 'THIRD_PARTY_NOTICES.md');
  await writeFile(file, (await readFile(file, 'utf8')).split('\n').filter(line => !line.startsWith('| saxes |')).join('\n'));
  await expect(check(cwd)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Third-party notice index is stale') });
});

it('rejects dropping the notice from package inclusion', async () => {
  const cwd = await fixture();
  const file = join(cwd, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as { files: string[] };
  manifest.files = manifest.files.filter(path => path !== 'THIRD_PARTY_NOTICES.md');
  await writeFile(file, JSON.stringify(manifest));
  await expect(check(cwd)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Package must include third-party notices') });
});

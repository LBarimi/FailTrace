import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/check-docs.mjs');
const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
async function fixture(): Promise<string> {
  const cwd = await temporaryDirectory(); directories.push(cwd);
  for (const path of ['docs', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'AGENTS.md', 'LICENSE',
    'package.json', 'package-lock.json', 'server.json', 'src', 'examples', '.github', 'tests', 'scripts']) {
    await cp(join(root, path), join(cwd, path), { recursive: true });
  }
  return cwd;
}
const check = (cwd: string) => promisify(execFile)(process.execPath, [script, cwd], { windowsHide: true, timeout: 10000 });
async function replace(cwd: string, path: string, from: string, to: string): Promise<void> {
  const file = join(cwd, path), text = await readFile(file, 'utf8');
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
}

it('accepts the documentation with historical release versions intact', async () => {
  const result = await check(root);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('Documentation checked:');
});

it('rejects a stale install command and mismatched MCP package version', async () => {
  const cwd = await fixture();
  const version = (await readFile(join(cwd, 'docs/INSTALL.md'), 'utf8')).match(/published version used here is \*\*(\d+\.\d+\.\d+)\*\*/)?.[1];
  expect(version).toBeDefined();
  await replace(cwd, 'README.md', `failtrace@${version}`, 'failtrace@0.0.0');
  const server = JSON.parse(await readFile(join(cwd, 'server.json'), 'utf8')) as { packages: Array<{ version: string }> };
  server.packages[0]!.version = '0.0.0';
  await writeFile(join(cwd, 'server.json'), JSON.stringify(server));
  await expect(check(cwd)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('installation pin 0.0.0') });
  await replace(cwd, 'README.md', 'failtrace@0.0.0', `failtrace@${version}`);
  await expect(check(cwd)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('npm package version differs') });
});

it('rejects broken guide paths and heading links', async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, 'docs/broken.md'), '# Broken\n\n[missing](absent.md)\n[heading](INSTALL.md#absent-heading)\n');
  const failure = await check(cwd).catch(error => error as { code: number; stderr: string });
  expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining('missing local link: absent.md') });
  expect(failure.stderr).toContain('missing heading: INSTALL.md#absent-heading');
});

it('rejects an asset changed independently of its checked demo recording', async () => {
  const cwd = await fixture();
  const image = join(cwd, 'docs/assets/demo-poster.png');
  await mkdir(dirname(image), { recursive: true });
  await writeFile(image, Buffer.from('unrecorded image'));
  await expect(check(cwd)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('asset digest differs') });
});

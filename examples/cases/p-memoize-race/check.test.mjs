import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import affected from 'memoize-affected';
import fixed from 'memoize-fixed';
import { observeMemoization } from './race.mjs';

const execute = promisify(execFile);
const cwd = dirname(fileURLToPath(import.meta.url));
const parent = join(cwd, '.failtrace');
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(join(parent, 'oracle-'));
const owned = await realpath(temporary);
for (const file of ['check.mjs', 'race.mjs', 'release.mjs', 'schedule.json']) await copyFile(join(cwd, file), join(temporary, file));
after(async () => {
  const entry = await lstat(temporary);
  assert(entry.isDirectory() && !entry.isSymbolicLink());
  assert.equal(await realpath(temporary), owned);
  assert.equal(dirname(owned), await realpath(parent));
  await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
const signature = 'P_MEMOIZE_DUPLICATE_IN_FLIGHT';
async function check(index = 1) {
  try {
    const result = await execute(process.execPath, [join(temporary, 'check.mjs')], {
      cwd: temporary, windowsHide: true, timeout: 10_000,
      env: { ...process.env, FAILTRACE_TRIAL_INDEX: String(index) },
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('published affected release duplicates only overlapping work; fixed release deduplicates both schedules', async () => {
  for (const [memoize, overlapCalls] of [[affected, 2], [fixed, 1]]) {
    assert.equal((await observeMemoization(memoize, 'sequential')).invocations, 1);
    assert.equal((await observeMemoization(memoize, 'overlap')).invocations, overlapCalls);
  }
});

test('the six predeclared schedules yield exactly three race matches in the affected release', async () => {
  for (let index = 1; index <= 6; index++) {
    const result = await check(index);
    assert.equal(result.code, index % 2 === 1 ? 1 : 0);
    assert.equal(result.stderr.trim(), index % 2 === 1 ? signature : '');
    assert.equal(JSON.parse(result.stdout).invocations, index % 2 === 1 ? 2 : 1);
  }
});

test('a source selection change gives six healthy fixed-release exits with unchanged schedules', async () => {
  const original = await readFile(join(temporary, 'release.mjs'), 'utf8');
  try {
    await writeFile(join(temporary, 'release.mjs'), "export const packageName = 'memoize-fixed';\n");
    for (let index = 1; index <= 6; index++) {
      const result = await check(index);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).invocations, 1);
    }
  } finally { await writeFile(join(temporary, 'release.mjs'), original); }
});

test('invalid schedule and missing release selection cannot imitate the failure signature', async () => {
  const source = await readFile(join(temporary, 'release.mjs'), 'utf8');
  const schedule = await readFile(join(temporary, 'schedule.json'), 'utf8');
  try {
    await writeFile(join(temporary, 'schedule.json'), JSON.stringify({ schedules: [signature] }));
    const invalid = await check();
    assert.equal(invalid.code, 2);
    assert.equal(invalid.stderr.trim(), 'CASE_SETUP_ERROR');
    await writeFile(join(temporary, 'schedule.json'), schedule);
    await writeFile(join(temporary, 'release.mjs'), "export const packageName = 'missing-package';\n");
    const missing = await check();
    assert.equal(missing.code, 2);
    assert.equal(missing.stderr.trim(), 'CASE_SETUP_ERROR');
  } finally {
    await writeFile(join(temporary, 'release.mjs'), source);
    await writeFile(join(temporary, 'schedule.json'), schedule);
  }
});

test('an explicit Verify engine path cannot silently fall back to another installation', async () => {
  const loader = new URL('../verify-engine.mjs', import.meta.url).href;
  const missing = join(temporary, 'explicit-engine-does-not-exist.mjs');
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(loader)});`], {
    windowsHide: true, env: { ...process.env, FAILTRACE_PACKAGE: missing, FAILTRACE_EXPECT_VERSION: '0.5.0' },
  }), error => error.code === 1 && error.stderr.includes('explicit-engine-does-not-exist.mjs'));
  const oldEngine = join(temporary, 'engine-without-verify.mjs');
  await writeFile(oldEngine, "export const VERSION = '0.5.0';\n");
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(loader)});`], {
    windowsHide: true, env: { ...process.env, FAILTRACE_PACKAGE: oldEngine, FAILTRACE_EXPECT_VERSION: '0.5.0' },
  }), error => error.code === 1 && error.stderr.includes('exports verifyFix'));
});

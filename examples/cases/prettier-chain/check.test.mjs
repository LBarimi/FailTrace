import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

const execute = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), 'check.mjs');
const temporaryParent = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryParent, 'failtrace-prettier-oracle-'));
const ownedTemporary = await realpath(temporary);
after(async () => {
  const entry = await lstat(temporary);
  assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Refuse cleanup of a replaced temporary directory');
  const target = await realpath(temporary);
  assert.equal(target, ownedTemporary, 'Cleanup must target only the directory created by this test');
  assert.equal(dirname(target), temporaryParent, 'Cleanup must stay inside the canonical temporary parent');
  assert.match(basename(target), /^failtrace-prettier-oracle-[^/\\]+$/);
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
const signature = 'PRETTIER_NOT_IDEMPOTENT';
async function check(input, selected = 'affected') {
  try {
    const result = await execute(process.execPath, [script, selected], {
      cwd: temporary, windowsHide: true, timeout: 10_000,
      env: { ...process.env, FAILTRACE_INPUT: input },
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('the reported upstream input fails only the affected formatter', async () => {
  const input = join(temporary, 'upstream.ts');
  await writeFile(input, 'Foo.a()\n\n.b()\n');
  const affected = await check(input);
  assert.equal(affected.code, 1);
  assert.equal(affected.stderr.trim(), signature);
  const passes = JSON.parse(affected.stdout);
  assert.equal(passes.first, 'Foo.a()\n.b();\n');
  assert.equal(passes.second, 'Foo.a().b();\n');
  const fixed = await check(input, 'fixed');
  assert.equal(fixed.code, 0);
  assert.equal(fixed.stderr, '');
});

test('syntax errors cannot imitate the signature through echoed source', async () => {
  const input = join(temporary, 'invalid.ts');
  await writeFile(input, `const ${signature} = ;\n`);
  const result = await check(input);
  assert.equal(result.code, 2);
  assert.equal(result.stderr.trim(), 'CANDIDATE_PARSE_ERROR');
  assert(!result.stderr.includes(signature));
});

test('stable code containing the signature is not the target defect', async () => {
  const input = join(temporary, 'stable.ts');
  await writeFile(input, `const message = "${signature}";\n`);
  const result = await check(input);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
});

test('missing input and unknown release selection cannot pass the check', async () => {
  const missing = await check(join(temporary, 'missing.ts'));
  assert.equal(missing.code, 2);
  assert.equal(missing.stderr.trim(), 'CASE_SETUP_ERROR');
  const unknown = await check(join(temporary, 'missing.ts'), 'latest');
  assert.equal(unknown.code, 2);
  assert(!unknown.stderr.includes(signature));
});

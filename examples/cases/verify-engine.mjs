import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Source checkout by default; callers can explicitly select an installed artifact.
// An invalid explicit path fails and never falls back to another implementation.
const entry = await realpath(process.env.FAILTRACE_PACKAGE === undefined
  ? fileURLToPath(new URL('../../dist/core/index.js', import.meta.url))
  : resolve(process.env.FAILTRACE_PACKAGE));
const expectedVersion = process.env.FAILTRACE_PACKAGE === undefined
  ? JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version
  : process.env.FAILTRACE_EXPECT_VERSION;
assert.equal(typeof expectedVersion, 'string', 'Set FAILTRACE_EXPECT_VERSION when selecting an explicit installed package');
const engine = await import(pathToFileURL(entry).href);
assert.equal(engine.VERSION, expectedVersion, 'Use the intended Verify-capable FailTrace version');
assert.equal(typeof engine.verifyFix, 'function', 'Build or explicitly select a package that exports verifyFix');
export const { VERSION, runTrials, loadRun, verifyFix, compareRuns } = engine;
export const quote = value => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;

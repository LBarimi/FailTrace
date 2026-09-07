import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { minimizeFailure } from '../src/core/index.js';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));

it('explains single-trial sampling and retains a reproducer with an explicit intermittent budget', async () => {
  const cwd = await temporaryDirectory(); directories.push(cwd);
  await writeFile(join(cwd, 'cases.json'), '["padding","BUG"]');
  // Every input alternates healthy/target outcomes. No randomness or timing dependency.
  await writeFile(join(cwd, 'check.mjs'), `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const counts = existsSync('counts.json') ? JSON.parse(readFileSync('counts.json', 'utf8')) : {};
const key = JSON.stringify(input);
counts[key] = (counts[key] ?? 0) + 1;
writeFileSync('counts.json', JSON.stringify(counts));
if (input.includes('BUG') && counts[key] % 2 === 0) { console.error('SAMPLED_TARGET'); process.exitCode = 7; }
`);
  const options = { cwd, command: process.execPath, args: ['check.mjs', '{input}'], input: 'cases.json', format: 'json' as const,
    predicate: { kind: 'stderr_contains' as const, value: 'SAMPLED_TARGET' } };
  const one = await minimizeFailure(options);
  expect(one).toMatchObject({ status: 'not_reproduced', finalVerified: false, repeat: 1 });
  expect(one.samplingWarnings?.[0]).toContain('--repeat 5 --min-failures 1');
  await writeFile(join(cwd, 'counts.json'), '{}');
  const repeated = await minimizeFailure({ ...options, repeat: 3 });
  expect(repeated).toMatchObject({ status: 'completed', finalVerified: true, samplingWarnings: [] });
  expect(JSON.parse(await readFile(repeated.minimizedPath, 'utf8'))).toEqual(['BUG']);
  expect(repeated.evaluations.some(item => item.phase === 'candidate' && item.accepted)).toBe(true);
}, 30_000);

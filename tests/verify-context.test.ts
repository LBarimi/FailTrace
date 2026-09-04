import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { assessBaselineEligibility, runTrials, verifyFix } from '../src/core/index.js';
import { runGit } from '../src/core/git.js';
import { writeRunSummary } from '../src/core/run-metadata.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory } from './helpers.js';

const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
const command = `${quoteShellArgument(process.execPath)} check.mjs`;
async function workspace(git = false): Promise<string> {
  const cwd = await temporaryDirectory();
  directories.push(cwd);
  await copyFile(fileURLToPath(new URL('./fixtures/verify-command.mjs', import.meta.url)), join(cwd, 'check.mjs'));
  await writeFile(join(cwd, 'release.json'), '{"mode":"bug"}');
  if (git) {
    await runGit(cwd, ['init']);
    await runGit(cwd, ['config', 'user.name', 'Verify Test']);
    await runGit(cwd, ['config', 'user.email', 'verify@example.invalid']);
    await runGit(cwd, ['add', 'check.mjs', 'release.json']);
    await runGit(cwd, ['commit', '-m', 'Baseline fixture']);
  }
  return cwd;
}

it('captures Git revision, dirty patch and untracked identities while excluding generated evidence', async () => {
  const cwd = await workspace(true);
  await writeFile(join(cwd, 'removed.mjs'), '// obsolete helper\n');
  await runGit(cwd, ['add', 'removed.mjs']);
  await runGit(cwd, ['commit', '-m', 'Add a helper to delete in the source intervention']);
  await writeFile(join(cwd, 'untracked.txt'), 'original untracked data');
  const baseline = await runTrials({ command, cwd, repeat: 1, captureContext: {} });
  expect(baseline.context?.workingDirectory).toBe(await realpath(cwd));
  expect(baseline.context?.stable).toBe(true);
  expect(baseline.context?.before.source).toMatchObject({ kind: 'git', commit: await runGit(cwd, ['rev-parse', 'HEAD']),
    untracked: [{ path: 'untracked.txt', bytes: 23, sha256: createHash('sha256').update('original untracked data').digest('hex') }] });
  await writeFile(join(cwd, 'release.json'), '{"mode":"fixed"}');
  await rm(join(cwd, 'removed.mjs'));
  const result = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command,
    allowChanges: [{ field: 'source', reason: 'Change the tracked implementation.' }] });
  expect(result.status).toBe('target_not_observed');
  expect(result.candidate?.context?.stable).toBe(true);
  const before = result.baseline!.context!.before.source;
  const after = result.candidate!.context!.before.source;
  if (before.kind !== 'git' || after.kind !== 'git') throw new Error('Expected Git context');
  expect(before.patchSha256).not.toEqual(after.patchSha256);
  expect(before.commit).toEqual(after.commit);
  expect(before.untracked).toEqual(after.untracked);
  expect(after.deleted).toEqual(['removed.mjs']);
  await writeFile(join(cwd, 'untracked.txt'), 'changed untracked data');
  const rejected = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command });
  expect(rejected.status).toBe('inconclusive');
  expect(rejected.candidate).toBeNull();
  expect(rejected.changes[0]?.field).toBe('source');
});

it('gives explicit source files precedence over an enclosing Git repository', async () => {
  const parent = await workspace(true);
  const cwd = join(parent, '.failtrace', 'case');
  await mkdir(cwd, { recursive: true });
  for (const file of ['check.mjs', 'release.json']) await copyFile(join(parent, file), join(cwd, file));
  const baseline = await runTrials({ command, cwd, repeat: 1, captureContext: { sourceFiles: ['check.mjs', 'release.json'] } });
  expect(baseline.context?.before.source.kind).toBe('files');
  await writeFile(join(parent, 'release.json'), 'an unrelated outer checkout edit');
  const result = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command });
  expect(result.status).toBe('target_observed');
  expect(result.changes).toEqual([]);
});

it('hashes declared binary bytes and requires separate allowances for overlapping scopes', async () => {
  const cwd = await workspace();
  const bytes = Buffer.from([0, 1, 2, 255, 128, 13, 10]);
  await writeFile(join(cwd, 'data.bin'), bytes);
  const baseline = await runTrials({ command, cwd, repeat: 1,
    captureContext: { inputFiles: ['data.bin', 'release.json'], sourceFiles: ['check.mjs', 'release.json'] } });
  expect(baseline.context?.before.inputs[0]).toEqual({ path: 'data.bin', bytes: 7, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(join(cwd, 'release.json'), '{"mode":"fixed"}');
  const result = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command,
    allowChanges: [{ field: 'source', reason: 'Proposed patch.' }] });
  expect(result.status).toBe('inconclusive');
  expect(result.candidate).toBeNull();
  expect(result.changes.map(({ field, allowed }) => ({ field, allowed }))).toEqual([{ field: 'inputs', allowed: false }, { field: 'source', allowed: true }]);
});

it('treats unknown, missing and unsafe saved provenance as ineligible without reading outside cwd', async () => {
  const cwd = await workspace();
  const unknown = await runTrials({ command, cwd, repeat: 1, captureContext: {} });
  expect(assessBaselineEligibility(unknown).eligible).toBe(false);
  const missing = await runTrials({ command, cwd, repeat: 1, captureContext: { sourceFiles: ['missing.mjs'] } });
  expect(missing.context?.before.issues).toEqual(['A declared context file is missing.']);
  expect(assessBaselineEligibility(missing).eligible).toBe(false);
  const baseline = await runTrials({ command, cwd, repeat: 1, captureContext: { sourceFiles: ['check.mjs'] } });
  baseline.context!.declaration.sourceFiles = ['../outside.txt'];
  await writeRunSummary(baseline);
  const result = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command });
  expect(result.baselineEligibility.eligible).toBe(false);
  expect(result.candidate).toBeNull();
  expect(JSON.parse(await readFile(result.metadataPath, 'utf8')).status).toBe('inconclusive');
});

it.each(['--assume-unchanged', '--skip-worktree'])('refuses automatic Git comparison when %s hides source changes', async (flag) => {
  const cwd = await workspace(true);
  const baseline = await runTrials({ command, cwd, repeat: 1, captureContext: {} });
  expect(assessBaselineEligibility(baseline).eligible).toBe(true);
  await runGit(cwd, ['update-index', flag, 'release.json']);
  await writeFile(join(cwd, 'release.json'), '{"mode":"fixed"}');
  expect(await runGit(cwd, ['diff', 'HEAD'])).toBe('');
  const result = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command });
  expect(result.status).toBe('inconclusive');
  expect(result.candidate).toBeNull();
  const flagged = await runTrials({ command, cwd, repeat: 1, captureContext: {} });
  expect(assessBaselineEligibility(flagged).eligible).toBe(false);
  expect(flagged.context?.before.issues.join(' ')).toContain('assume-unchanged or skip-worktree');
});

it('detects working-tree source bytes hidden by a Git clean filter', async () => {
  const cwd = await workspace(true);
  await writeFile(join(cwd, '.gitattributes'), 'release.json filter=verify\n');
  await writeFile(join(cwd, 'normalize.mjs'), 'process.stdout.write(JSON.stringify({ mode: "bug" }));\n');
  await runGit(cwd, ['config', 'filter.verify.clean', `${quoteShellArgument(process.execPath)} normalize.mjs`]);
  await runGit(cwd, ['add', '.gitattributes', 'normalize.mjs']);
  await runGit(cwd, ['commit', '-m', 'Define the local normalization fixture']);
  const baseline = await runTrials({ command, cwd, repeat: 1, captureContext: {} });
  expect(assessBaselineEligibility(baseline).eligible).toBe(true);
  await writeFile(join(cwd, 'release.json'), '{"mode":"fixed"}');
  expect(await runGit(cwd, ['diff', 'HEAD'])).toBe('');
  const rejected = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command });
  expect(rejected.status).toBe('inconclusive');
  expect(rejected.candidate).toBeNull();
  expect(rejected.changes.map((change) => change.field)).toEqual(['source']);
  const allowed = await verifyFix({ baseline: baseline.artifactDirectory, cwd, command,
    allowChanges: [{ field: 'source', reason: 'Record the changed raw implementation despite the clean filter.' }] });
  expect(allowed.status).toBe('target_not_observed');
  const before = allowed.baseline!.context!.before.source;
  const after = allowed.candidate!.context!.before.source;
  if (before.kind !== 'git' || after.kind !== 'git') throw new Error('Expected Git context');
  expect(before.patchSha256).toBe(after.patchSha256);
  expect(before.tracked).not.toEqual(after.tracked);
});

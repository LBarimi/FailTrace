import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/bench-workflows.mjs', import.meta.url));
const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));
async function workspace() { const cwd = await temporaryDirectory(); directories.push(cwd); return cwd; }

describe('original workflow performance evidence', () => {
  it('refuses an existing output directory before replacing its contents', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'report.json'), 'keep existing evidence');
    await expect(execute(process.execPath, [script, '--output', cwd], { windowsHide: true })).rejects.toThrow('EEXIST');
    expect(await readFile(join(cwd, 'report.json'), 'utf8')).toBe('keep existing evidence');
    expect(await readdir(cwd)).toEqual(['report.json']);
  });

  it('rejects unbounded or malformed workloads before creating output', async () => {
    const cwd = await workspace();
    for (const invalid of [['--samples', '0'], ['--records', '3'], ['--records', '10002'], ['--repeat', '21'], ['--unknown', 'value']]) {
      await expect(execute(process.execPath, [script, ...invalid, '--output', join(cwd, 'unused')], { windowsHide: true })).rejects.toThrow();
    }
    expect(await readdir(cwd)).toEqual([]);
  });

  it('measures actual paired targets and the full investigation without exposing worker paths or logs', async () => {
    const cwd = await workspace();
    const output = join(cwd, 'new-report');
    const { stdout } = await execute(process.execPath, [script, '--samples', '1', '--records', '4', '--repeat', '1', '--output', output],
      { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'passed', samples: 1, cases: 10 });
    const text = await readFile(join(output, 'report.json'), 'utf8');
    expect(text).not.toContain(cwd);
    expect(text).not.toContain(process.execPath);
    expect(text).not.toContain('IMPORT_REVISION_LOST');
    const report = JSON.parse(text);
    expect(report.coreJavaScriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
    const workflow = report.results.find((entry: { mode: string }) => entry.mode === 'workflow');
    expect(workflow.outcomes).toMatchObject({ initialRecords: 4, reducedRecords: 2, finalVerified: true,
      ineffectiveFix: 'target_observed', unrelatedError: 'inconclusive', skippedCheck: 'inconclusive', validFix: 'target_not_observed', replay: 'target_observed' });
    expect(workflow.outcomes.evidenceBytes).toBeGreaterThan(0);
    expect(workflow.stages.map((stage: { phase: string }) => stage.phase)).toContain('inventory');
    for (const entry of report.results) for (const stage of entry.stages) {
      expect(stage.wallMs).toBeGreaterThan(0);
      expect(stage.unmeasuredWriteCalls).toBe(0);
    }
  }, 60000);
});

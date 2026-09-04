import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupDirectories, temporaryDirectory } from './helpers.js';

const execute = promisify(execFile);
const configUrl = new URL('../scripts/bench/config.mjs', import.meta.url);
const { parseOptions, buildCases, checkBudgets } = await import(configUrl.href);
const directories: string[] = [];
afterEach(async () => cleanupDirectories(directories));

describe('performance benchmark safeguards', () => {
  it('keeps the default bounded and exposes all 192 full-matrix cases only on request', () => {
    expect(buildCases(parseOptions([]))).toHaveLength(6);
    expect(buildCases(parseOptions(['--suite', 'ci']))).toHaveLength(4);
    expect(buildCases(parseOptions(['--suite', 'full']))).toHaveLength(192);
    expect(buildCases(parseOptions(['--durations', 'noop', '--repeats', '1', '--outputs', '0', '--predicates', 'regex'])))
      .toEqual([{ durationMs: 0, repeat: 1, outputBytes: 0, predicate: 'regex' }]);
  });

  it('rejects invalid axes, missing values and private paths in labels', () => {
    for (const args of [['--repeats', '-1'], ['--repeats', '1001'], ['--outputs', 'large'], ['--suite'],
      ['--label', 'C:/Users/you'], ['--unknown']]) expect(() => parseOptions(args)).toThrow();
  });

  it('refuses an existing output directory before replacing reports or fixtures', async () => {
    const directory = await temporaryDirectory();
    directories.push(directory);
    const report = join(directory, 'report.json');
    await writeFile(report, 'unrelated evidence');
    await expect(execute(process.execPath, [fileURLToPath(new URL('../scripts/bench.mjs', import.meta.url)),
      '--output', directory], { windowsHide: true })).rejects.toThrow('EEXIST');
    expect(await readFile(report, 'utf8')).toBe('unrelated evidence');
  });

  it('accepts linear metadata and detects quadratic growth independently of timing noise', () => {
    const results = [10, 100].flatMap((repeat) => [{ id: `core-${repeat}`, mode: 'failtrace',
      case: { repeat, durationMs: 0, outputBytes: 0, predicate: 'nonzero_exit' }, wallMs: 2000,
      io: { metadataBytesWritten: repeat * 2000, fsyncCalls: repeat + 2 } },
    { mode: 'direct-shell', case: { repeat, durationMs: 0, outputBytes: 0 }, wallMs: 1000 }]);
    expect(checkBudgets(results)).toEqual([]);
    const large = results[2]! as { io: { metadataBytesWritten: number } };
    large.io.metadataBytesWritten = 3_000_000;
    expect(checkBudgets(results)).toContain('core-100: metadata byte budget exceeded');
    expect(checkBudgets(results)).toContain('Metadata growth exceeds the 15x allowance for 10x more trials.');
    (results[0]! as { io: { fsyncCalls: number } }).io.fsyncCalls = 22;
    expect(checkBudgets(results)).toContain('core-10: fsync budget exceeded');
    expect(checkBudgets([])).toContain('Structural guard requires noop / 0 bytes / nonzero_exit cases at repeats 10 and 100.');
  });

  it('counts successful logical metadata writes and fsync without double counting FileHandle internals', async () => {
    const directory = await temporaryDirectory();
    directories.push(directory);
    const script = `
      import { open, writeFile, appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const directory = process.argv[1];
      globalThis.__failtraceBenchmark.reset();
      await writeFile(join(directory, 'run.json'), 'abc');
      await appendFile(join(directory, 'run.json'), 'de');
      const handle = await open(join(directory, 'trial.json.uuid.tmp'), 'wx');
      await handle.writeFile('abcdef');
      await handle.write(Buffer.from('ghi'));
      await handle.sync();
      await handle.close();
      await writeFile(join(directory, 'stdout.txt'), '12345');
      console.log(JSON.stringify(globalThis.__failtraceBenchmark.snapshot()));
    `;
    const { stdout } = await execute(process.execPath, ['--import', new URL('../scripts/bench/instrument.mjs', import.meta.url).href,
      '--input-type=module', '-e', script, directory], { windowsHide: true });
    const metrics = JSON.parse(stdout) as { metadataBytesWritten: number; parentBytesWritten: number; fsyncCalls: number; fsyncCompleted: number; unmeasuredWriteCalls: number };
    expect(metrics.metadataBytesWritten).toBe(14);
    expect(metrics.parentBytesWritten).toBe(19);
    expect(metrics.fsyncCalls).toBe(1);
    expect(metrics.fsyncCompleted).toBe(1);
    expect(metrics.unmeasuredWriteCalls).toBe(0);
  });

  it('runs a real zero-byte text predicate case without requiring the predicate to match', async () => {
    const directory = await temporaryDirectory();
    directories.push(directory);
    const { stdout } = await execute(process.execPath, ['--import', new URL('../scripts/bench/instrument.mjs', import.meta.url).href,
      fileURLToPath(new URL('../scripts/bench/worker.mjs', import.meta.url)), JSON.stringify({ mode: 'failtrace', directory,
        corePath: fileURLToPath(new URL('../dist/core/index.js', import.meta.url)),
        configuration: { durationMs: 0, repeat: 1, outputBytes: 0, predicate: 'substring' } })], { windowsHide: true });
    const result = JSON.parse(stdout) as { matchedTrials: number; io: { metadataBytesWritten: number } };
    expect(result.matchedTrials).toBe(0);
    expect(result.io.metadataBytesWritten).toBeGreaterThan(0);
    expect(stdout).not.toContain(directory);
    expect(stdout).not.toContain(process.execPath);
  });
});

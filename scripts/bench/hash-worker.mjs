import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quoteExecutable } from './config.mjs';

const { directory, corePath } = JSON.parse(process.argv[2]);
await mkdir(directory, { recursive: true });
await copyFile(fileURLToPath(new URL('./target.mjs', import.meta.url)), join(directory, 'target.mjs'));
const { runTrials, compareRuns } = await import(pathToFileURL(corePath).href);
const outputBytes = 16 * 1024 * 1024;
const comparisons = 10;
const summary = await runTrials({ command: `${quoteExecutable(process.execPath)} target.mjs`, cwd: directory,
  repeat: 2, env: { FAILTRACE_BENCH_DURATION_MS: '0', FAILTRACE_BENCH_OUTPUT_BYTES: String(outputBytes) } });
if (summary.trials.some((trial) => trial.exitCode !== 1 || trial.error)) throw new Error('Hash fixture failed.');
async function measure(action) {
  globalThis.__failtraceBenchmark.reset();
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await action();
  const elapsed = performance.now() - started;
  const used = process.cpuUsage(cpu);
  return { wallMs: elapsed, cpuMs: (used.user + used.system) / 1000, io: globalThis.__failtraceBenchmark.snapshot(), result };
}
const uncached = await measure(async () => {
  let reportedBytes = 0;
  for (let index = 0; index < comparisons; index++) {
    const comparison = await compareRuns({ runA: summary.artifactDirectory, trialA: 1, trialB: 2 });
    if (!comparison.stdout.equal || !comparison.stderr.equal) throw new Error('Expected identical output.');
    reportedBytes += comparison.stdout.bytesA + comparison.stdout.bytesB + comparison.stderr.bytesA + comparison.stderr.bytesB;
  }
  return { reportedOutputBytesCompared: reportedBytes };
});
const digest = async (path) => {
  const hash = createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytesRead += chunk.length; }
  return { sha256: hash.digest('hex'), bytesRead };
};
const eagerHash = await measure(async () => Promise.all(summary.trials.flatMap((trial) => [trial.stdoutPath, trial.stderrPath])
  .map((path) => digest(join(summary.artifactDirectory, path)))));
const cachedLookup = await measure(async () => {
  const [a, b, c, d] = eagerHash.result;
  for (let index = 0; index < comparisons; index++) {
    if (a.sha256 !== c.sha256 || b.sha256 !== d.sha256) throw new Error('Cached hash mismatch.');
  }
  return { comparisons };
});
process.stdout.write(`${JSON.stringify({ comparisons, outputBytesPerTrial: outputBytes,
  uncachedCompare: uncached, eagerHash: { wallMs: eagerHash.wallMs, cpuMs: eagerHash.cpuMs, io: eagerHash.io,
    bytesRead: eagerHash.result.reduce((sum, item) => sum + item.bytesRead, 0) }, cachedLookup,
  caveat: 'Warm filesystem-cache experiment. Uncached is the real compare API including artifact validation; eagerHash and cachedLookup are a prototype cost floor, not a replacement API. Cached hashes assume immutable logs and omit hash metadata persistence, validation and different-output diffs; current artifacts can be edited. No target JS piping benchmark or evidence for changing the default capture path.' })}\n`);

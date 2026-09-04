import { spawn } from 'node:child_process';
import { copyFile, mkdir, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quoteExecutable } from './config.mjs';

const input = JSON.parse(process.argv[2]);
const { mode, directory, corePath, configuration } = input;
await mkdir(directory, { recursive: true });
await copyFile(fileURLToPath(new URL('./target.mjs', import.meta.url)), join(directory, 'target.mjs'));
const environment = { ...process.env, FAILTRACE_BENCH_DURATION_MS: String(configuration.durationMs),
  FAILTRACE_BENCH_OUTPUT_BYTES: String(configuration.outputBytes) };
// Both baselines use exactly the same command, cwd, environment and output redirection as Core.
const command = `${quoteExecutable(process.execPath)} target.mjs`;
const core = mode === 'failtrace' ? await import(pathToFileURL(corePath).href) : null;
const predicate = configuration.predicate === 'substring' ? { kind: 'stdout_contains', value: 'FAILTRACE_BENCH_MATCH' }
  : configuration.predicate === 'regex' ? { kind: 'stdout_regex', pattern: 'FAILTRACE_BENCH_MATCH' }
    : configuration.predicate === 'exit_code' ? { kind: 'exit_code', value: 1 } : { kind: 'nonzero_exit' };

async function directTrial(index) {
  const targetDirectory = join(directory, 'artifacts', String(index));
  await mkdir(targetDirectory, { recursive: true });
  const stdout = await open(join(targetDirectory, 'stdout.txt'), 'wx');
  const stderr = await open(join(targetDirectory, 'stderr.txt'), 'wx');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(mode === 'direct-shell' ? command : process.execPath,
        mode === 'direct-shell' ? [] : ['target.mjs'], { cwd: directory,
          shell: mode === 'direct-shell', windowsHide: true,
          env: { ...environment, FAILTRACE_TRIAL_INDEX: String(index) }, stdio: ['ignore', stdout.fd, stderr.fd] });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 1 && signal === null ? resolve() : reject(new Error('Unexpected benchmark target exit.')));
    });
  } finally { await Promise.all([stdout.close(), stderr.close()]); }
}
async function sizeOf(path) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) { const child = await sizeOf(target); bytes += child.bytes; files += child.files; }
    else { bytes += (await stat(target)).size; files++; }
  }
  return { bytes, files };
}
function resources(start, cpu) {
  const elapsed = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  const peak = process.resourceUsage().maxRSS;
  return { wallMs: elapsed, cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000,
    peakRssBytes: peak > 0 ? peak * 1024 : null, throughputTrialsPerSecond: configuration.repeat * 1000 / elapsed };
}
globalThis.__failtraceBenchmark.reset();
const cpu = process.cpuUsage();
const started = performance.now();
let artifactDirectory = join(directory, 'artifacts');
let matchedTrials = null;
let completedTrials = configuration.repeat;
let decision = null;
if (mode === 'failtrace') {
  const summary = await core.runTrials({ command, cwd: directory, artifactsDir: artifactDirectory,
    repeat: configuration.repeat, timeoutMs: Math.max(30_000, configuration.durationMs * 10), predicate, env: environment,
    ...(configuration.concurrency === undefined ? {} : { concurrency: configuration.concurrency }),
    ...(configuration.minFailures === undefined ? {} : { stopWhenDecided: { minFailures: configuration.minFailures } }) });
  const expectedTrials = configuration.minFailures ?? configuration.repeat;
  const expectedMatches = configuration.outputBytes > 0 || ['nonzero_exit', 'exit_code'].includes(configuration.predicate)
    ? expectedTrials : 0;
  matchedTrials = summary.trials.filter((trial) => trial.failureMatched).length;
  if (summary.status !== 'completed' || summary.trials.length !== expectedTrials || matchedTrials !== expectedMatches
    || summary.trials.some((trial) => trial.exitCode !== 1 || trial.error)) throw new Error('Benchmark run did not complete the expected target experiment.');
  completedTrials = summary.trials.length;
  decision = summary.decision ?? null;
  artifactDirectory = summary.artifactDirectory;
} else {
  for (let index = 1; index <= configuration.repeat; index++) await directTrial(index);
}
const measurement = resources(started, cpu);
measurement.throughputTrialsPerSecond = completedTrials * 1000 / measurement.wallMs;
const io = globalThis.__failtraceBenchmark.snapshot();
const artifact = await sizeOf(artifactDirectory);
if (artifact.bytes < completedTrials * configuration.outputBytes) throw new Error('Benchmark output was not fully saved.');
process.stdout.write(`${JSON.stringify({ mode, case: configuration, ...measurement, io, artifact, matchedTrials, completedTrials, decision })}\n`);

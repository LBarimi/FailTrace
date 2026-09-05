import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRun, safeArtifactPath } from './run-reader.js';
import type { FailurePredicate } from './types.js';
import { outputLimits, type OutputLimits } from './output-budget.js';
import { BundleWriter, DEFAULT_MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, portableRelativePath, type BundleFileEntry } from './bundle-files.js';
import { bundleEnvironment, type BundleEnvironmentRequirement } from './bundle-environment.js';
import { validateRunOptions, VERSION } from './run-trials.js';

export interface BundleOptions {
  run: string;
  cwd?: string;
  /** Explicit regular files, relative to the original run's working directory. */
  files?: string[];
  /** Optional file or directory used through FAILTRACE_INPUT / FAILTRACE_INPUT_DIR. */
  input?: string;
  /** Portable target command, evaluated from source/. */
  command?: string;
  /** Explicit environment overrides; null unsets a variable. */
  env?: Record<string, string | null>;
  /** Explicitly include these captured values; other captured keys become replay prerequisites. */
  includeEnv?: string[];
  /** Include unchanged original metadata/logs, which can contain private values and absolute paths. Default false. */
  includeEvidence?: boolean;
  /** Combined bytes in the complete bundle; default 512 MiB. */
  maxBundleBytes?: number;
  /** Must not exist. Defaults to cwd/.failtrace/reproduction/<bundle-id>. */
  destination?: string;
  signal?: AbortSignal;
}

export interface BundleResult {
  id: string;
  directory: string;
  configPath: string;
  sourceRunId: string;
  files: string[];
  manifestPath: string;
  evidenceIncluded: boolean;
  environmentKeys: string[];
  requiredEnvironment: BundleEnvironmentRequirement[];
  fileCount: number;
  totalBytes: number;
}

export interface BundleManifest {
  schemaVersion: 1;
  sourceRunId: string;
  evidenceIncluded: boolean;
  environmentKeys: string[];
  requiredEnvironment: BundleEnvironmentRequirement[];
  /** Content inventory excludes manifest.json itself. Hashes describe creation-time bytes, not trust or sanitization. */
  files: BundleFileEntry[];
  contentBytes: number;
}

interface ReproductionConfig extends Required<OutputLimits> {
  schemaVersion: 2;
  failtraceVersion: string;
  sourceRunId: string;
  command: string;
  repeat: number;
  concurrency: number;
  timeoutMs: number;
  predicate: FailurePredicate;
  sourceDirectory: 'source';
  artifactsDirectory: 'replay-artifacts';
  environment: Record<string, string | null>;
  requiredEnvironment: BundleEnvironmentRequirement[];
  evidenceIncluded: boolean;
  files: string[];
  input?: { path: string; kind: 'file' | 'directory' };
  sourceCommit?: string;
}

function checkCancellation(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Refuse links within the selected root, without rejecting OS aliases such as /var. */
async function assertNoSymlinks(path: string, root = dirname(path)): Promise<void> {
  const absolute = resolve(path);
  let current = resolve(root);
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Bundle paths cannot contain symbolic links: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function assertPortableCommand(command: string, originalCwd: string): void {
  if (!command.trim() || command.includes('\0')) throw new Error('Bundle command must be a non-empty string without null bytes.');
  const normalized = command.replaceAll('\\', '/');
  const original = originalCwd.replaceAll('\\', '/');
  if (normalized.includes(original) || normalized.includes(process.execPath.replaceAll('\\', '/'))
      || /^\s*["']?(?:[a-zA-Z]:\/|\/)/.test(normalized)) {
    throw new Error('The recorded command contains a machine-specific absolute path. Provide a portable command override, such as "node fixture.mjs".');
  }
}

const REPLAY_SCRIPT = `import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTrials } from './engine/run-trials.js';
import { assessRun } from './engine/predicates.js';

export async function replay() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(await readFile(resolve(directory, 'repro.json'), 'utf8'));
  if (config.schemaVersion !== 2) throw new Error('Unsupported reproduction configuration.');
  const environment = Object.create(null);
  for (const [key, value] of Object.entries(config.environment)) {
    environment[key] = value === null ? undefined : value;
  }
  const missing = config.requiredEnvironment.filter(({ key, state }) => {
    const inheritedKey = Object.keys(process.env).find((name) => process.platform === 'win32' ? name.toUpperCase() === key.toUpperCase() : name === key);
    const value = Object.hasOwn(environment, key) ? environment[key] : inheritedKey === undefined ? undefined : process.env[inheritedKey];
    return state === 'unset' ? value !== undefined : value === undefined;
  });
  if (missing.length) throw new Error('Supply the omitted captured environment before replay: ' + missing.map(({ key, state }) => key + ' must be ' + state).join(', '));
  if (config.input) {
    environment.FAILTRACE_INPUT = undefined;
    environment.FAILTRACE_INPUT_DIR = undefined;
    environment[config.input.kind === 'file' ? 'FAILTRACE_INPUT' : 'FAILTRACE_INPUT_DIR'] = resolve(directory, config.input.path);
  }
  const controller = new AbortController();
  let interruptedBy;
  const onSigint = () => { interruptedBy ??= 'SIGINT'; controller.abort(); };
  const onSigterm = () => { interruptedBy ??= 'SIGTERM'; controller.abort(); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const summary = await runTrials({
      command: config.command,
      repeat: config.repeat,
      concurrency: config.concurrency ?? 1,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      maxTotalOutputBytes: config.maxTotalOutputBytes,
      predicate: config.predicate,
      cwd: resolve(directory, config.sourceDirectory),
      artifactsDir: resolve(directory, config.artifactsDirectory),
      env: environment,
      signal: controller.signal,
      onTrialComplete: (trial) => console.log('Trial ' + trial.index + ': ' + trial.status),
    });
    const matches = summary.trials.filter((trial) => trial.failureMatched === true).length;
    const assessment = assessRun(summary);
    console.log('Target failure reproduced: ' + matches + ' / ' + summary.statistics.total);
    if (assessment === 'inconclusive') console.log('Replay inconclusive: execution did not complete cleanly.');
    console.log('Artifacts: ' + summary.artifactDirectory);
    return interruptedBy ? (interruptedBy === 'SIGTERM' ? 143 : 130) : assessment === 'inconclusive' ? 2 : matches > 0 ? 1 : 0;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

// Importing this module never starts the target command.
// Resolve aliases such as macOS /var -> /private/var and directory junctions.
const isMain = process.argv[1] && await Promise.all([
  realpath(resolve(process.argv[1])), realpath(fileURLToPath(import.meta.url)),
]).then(([invoked, module]) => invoked === module, () => false);
if (isMain) {
  replay().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error('Replay failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  });
}
`;

function bundleReadme(config: ReproductionConfig): string {
  return [
    '# FailTrace reproduction', '',
    'This directory contains the Core engine and selected source/input files. Creating it did not execute its command.', '',
    '## Review before sharing', '',
    '`manifest.json` lists relative paths, categories, byte counts and SHA-256 hashes for every content file except itself.',
    'The inventory describes creation-time bytes. It does not certify safety, redact secrets or identify trusted code.',
    config.evidenceIncluded
      ? 'Original metadata and logs are included unchanged under `logs/`. They can contain private output, captured environment values and absolute machine paths.'
      : 'Original metadata and logs are excluded. They remain intact in the source investigation.',
    'Only explicitly selected captured values and supplied environment overrides appear in `repro.json`.',
    'Selected source/input files, commands, predicates and explicit values can still contain private information. Review their contents before sharing.', '',
    '## Replay', '',
    '1. Install Node.js 22.12 or newer and external tools required by the target. The included Core needs no package installation or network connection.',
    '2. Read `manifest.json`, `repro.json`, the scripts and selected files. The command runs with your local permissions.',
    '3. Install target dependencies and perform setup in `source/`. Dependencies and external services are not captured automatically.',
    '4. Supply omitted captured environment keys listed in `requiredEnvironment`: set or unset each key as recorded. Missing prerequisites stop replay before command execution with exit 2. Values must suit the original experiment; presence checks cannot prove equivalent values.',
    '5. Run `node repro.mjs`, `sh repro.sh`, or `repro.cmd` from any directory.', '',
    'Replay runs from `source/` using the configured command, predicate, trial budget, timeout, output caps and concurrency. Concurrency can alter failures through shared state or contention.',
    'Exit 1 means at least one target match, 0 means no match in the completed sample, 2 means inconclusive or invalid execution, and 130/143 mean interruption. An unrelated nonzero exit does not match a specific output predicate.',
    'New evidence is saved under `replay-artifacts/runs/`. Creation-time file hashes do not cover later edits or replay output. Review new evidence separately before sharing it.', '',
    'Explicit environment overrides use null to unset a key. Other variables are inherited from the replay environment.',
    config.input ? 'The selected input is under `input/`; replay relocates FAILTRACE_INPUT or FAILTRACE_INPUT_DIR automatically.' : 'No separate input was selected.', '',
    '## Portability limits', '',
    'Target commands retain platform shell syntax and may require external tools, dependency installation, services and uncaptured state. The bundle does not reconstruct unselected files. Process-tree cleanup remains best effort.', '',
  ].join('\n');
}

/** Build a local, self-contained replay directory without executing its command. */
export async function createBundle(options: BundleOptions): Promise<BundleResult> {
  checkCancellation(options.signal);
  const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes < 1) throw new Error('maxBundleBytes must be a positive safe integer.');
  if (options.includeEvidence !== undefined && typeof options.includeEvidence !== 'boolean') throw new Error('includeEvidence must be a boolean.');
  if (options.files !== undefined && (!Array.isArray(options.files) || options.files.length > MAX_BUNDLE_FILES)) throw new Error('Select at most 10000 bundle files.');
  const cwd = resolve(options.cwd ?? process.cwd());
  const run = await loadRun(options.run, cwd);
  const command = options.command ?? run.command;
  assertPortableCommand(command, run.cwd);
  validateRunOptions({ command, repeat: run.requestedTrials, concurrency: run.concurrency ?? 1, timeoutMs: run.timeoutMs, predicate: run.predicate ?? { kind: 'nonzero_exit' }, ...outputLimits(run) });
  const files = [...new Set((options.files ?? []).map(portableRelativePath))].sort();
  const sourceRoot = files.length > 0 && run.source?.kind !== 'git' ? await realpath(run.cwd) : resolve(run.cwd);
  if (run.source?.kind !== 'git') {
    for (const file of files) {
      const source = join(sourceRoot, file);
      await assertNoSymlinks(source, sourceRoot);
      if (!(await lstat(source)).isFile()) throw new Error(`Selected source must be a regular file: ${file}`);
    }
  }
  const { environment, requiredEnvironment } = bundleEnvironment(run.environment?.variables, options.includeEnv, options.env);
  if (options.input !== undefined) {
    const managedInput = (key: string): boolean => ['FAILTRACE_INPUT', 'FAILTRACE_INPUT_DIR'].includes(key.toUpperCase());
    for (const key of Object.keys(environment).filter(managedInput)) {
      delete environment[key];
    }
    for (let index = requiredEnvironment.length - 1; index >= 0; index--) {
      if (managedInput(requiredEnvironment[index]!.key)) requiredEnvironment.splice(index, 1);
    }
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const engineDirectory = import.meta.url.endsWith('.js') ? moduleDirectory : resolve(moduleDirectory, '../../dist/core');
  await assertNoSymlinks(engineDirectory);
  await lstat(join(engineDirectory, 'run-trials.js')).catch(() => {
    throw new Error('Build FailTrace before creating a bundle from TypeScript sources: npm run build.');
  });
  const id = randomUUID();
  const requestedDirectory = resolve(cwd, options.destination ?? join('.failtrace', 'reproduction', id));
  await assertNoSymlinks(requestedDirectory);
  await mkdir(dirname(requestedDirectory), { recursive: true });
  const directory = join(await realpath(dirname(requestedDirectory)), basename(requestedDirectory));
  const engineRelative = relative(await realpath(engineDirectory), directory);
  if (!engineRelative || (!engineRelative.startsWith(`..${sep}`) && engineRelative !== '..' && !isAbsolute(engineRelative))) {
    throw new Error('Bundle destination must be outside the bundled engine directory.');
  }
  await mkdir(directory); // Exclusive: never reuse or overwrite an existing destination.
  const directoryIdentity = await lstat(directory, { bigint: true });
  const writer = new BundleWriter(directory, maxBundleBytes);
  try {
    checkCancellation(options.signal);
    await mkdir(join(directory, 'source'));
    for (const file of files) {
      checkCancellation(options.signal);
      if (run.source?.kind === 'git') {
        await writer.git(run.source, file, options.signal);
      } else {
        await writer.file(join(sourceRoot, file), `source/${file}`, 'source', options.signal);
      }
    }
    const config: ReproductionConfig = {
      schemaVersion: 2,
      failtraceVersion: VERSION,
      sourceRunId: run.id,
      command,
      repeat: run.requestedTrials,
      concurrency: run.concurrency ?? 1,
      timeoutMs: run.timeoutMs,
      ...outputLimits(run),
      predicate: run.predicate ?? { kind: 'nonzero_exit' },
      sourceDirectory: 'source',
      artifactsDirectory: 'replay-artifacts',
      environment,
      requiredEnvironment,
      evidenceIncluded: options.includeEvidence ?? false,
      files,
      ...(run.source?.kind === 'git' ? { sourceCommit: run.source.commit } : {}),
    };
    if (options.input !== undefined) {
      const input = resolve(cwd, options.input);
      await assertNoSymlinks(input);
      const info = await lstat(input);
      if (info.isDirectory()) {
        // Refuse to copy a directory that contains the destination into itself.
        const within = relative(await realpath(input), directory);
        if (!within || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within))) {
          throw new Error('Bundle destination must be outside the selected input directory.');
        }
        await writer.directory(input, 'input', 'input', options.signal);
        config.input = { path: 'input', kind: 'directory' };
      } else if (info.isFile()) {
        const filename = portableRelativePath(basename(input));
        await writer.file(input, `input/${filename}`, 'input', options.signal);
        config.input = { path: `input/${filename}`, kind: 'file' };
      } else {
        throw new Error('Bundle input must be a regular file or directory.');
      }
      delete environment.FAILTRACE_INPUT;
      delete environment.FAILTRACE_INPUT_DIR;
    }
    if (config.evidenceIncluded) {
      const evidencePaths = new Set(['run.json']);
      for (const trial of run.trials) {
        evidencePaths.add(trial.stdoutPath);
        evidencePaths.add(trial.stderrPath);
        evidencePaths.add(`${dirname(trial.stdoutPath).replaceAll('\\', '/')}/result.json`);
      }
      for (const path of evidencePaths) {
        checkCancellation(options.signal);
        const source = await safeArtifactPath(run.artifactDirectory, path);
        await writer.file(source, `logs/${portableRelativePath(path)}`, 'evidence', options.signal);
      }
    }
    await writer.directory(engineDirectory, 'engine', 'engine', options.signal, true);
    await writer.text('engine/package.json', '{"type":"module"}\n', 'engine');
    const license = await readFile(resolve(engineDirectory, '../../LICENSE'), 'utf8');
    await writer.text('engine/LICENSE', license, 'engine');
    await writer.text('repro.json', `${JSON.stringify(config, null, 2)}\n`, 'replay');
    await writer.text('README.md', bundleReadme(config), 'replay');
    await writer.text('repro.mjs', REPLAY_SCRIPT, 'replay');
    await writer.text('repro.sh', '#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2\nexec node "$SCRIPT_DIR/repro.mjs"\n', 'replay');
    await chmod(join(directory, 'repro.sh'), 0o755);
    await writer.text('repro.cmd', '@echo off\r\nnode "%~dp0repro.mjs"\r\nexit /b %errorlevel%\r\n', 'replay');
    const manifest: BundleManifest = { schemaVersion: 1, sourceRunId: run.id, evidenceIncluded: config.evidenceIncluded,
      environmentKeys: Object.keys(environment), requiredEnvironment,
      files: [...writer.files].sort((a, b) => a.path.localeCompare(b.path)), contentBytes: writer.totalBytes };
    await writer.text('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, 'replay');
    checkCancellation(options.signal);
    return { id, directory, configPath: join(directory, 'repro.json'), sourceRunId: run.id, files,
      manifestPath: join(directory, 'manifest.json'), evidenceIncluded: config.evidenceIncluded,
      environmentKeys: Object.keys(environment), requiredEnvironment, fileCount: writer.files.length, totalBytes: writer.totalBytes };
  } catch (error) {
    // Refuse cleanup if the exclusive destination was replaced or redirected.
    const current = await lstat(directory, { bigint: true });
    if (!current.isDirectory() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
      || await realpath(directory) !== directory) throw new Error('Bundle destination changed; refusing cleanup.', { cause: error });
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

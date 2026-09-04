import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyGitSourceFile } from './git-source.js';
import { loadRun, safeArtifactPath } from './run-reader.js';
import type { FailurePredicate } from './types.js';

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
}

interface ReproductionConfig {
  schemaVersion: 1;
  failtraceVersion: string;
  sourceRunId: string;
  command: string;
  repeat: number;
  timeoutMs: number;
  predicate: FailurePredicate;
  sourceDirectory: 'source';
  artifactsDirectory: 'replay-artifacts';
  environment: Record<string, string | null>;
  files: string[];
  input?: { path: string; kind: 'file' | 'directory' };
  sourceCommit?: string;
}

function checkCancellation(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function portableRelativePath(path: string): string {
  if (!path || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\0')) {
    throw new Error(`Bundle files must be relative paths inside the original working directory: ${path}`);
  }
  const parts = path.replaceAll('\\', '/').split('/').filter((part) => part !== '.');
  if (parts.length === 0 || parts.some((part) => !part || part === '..' || /[<>:"|?*]/.test(part)
      || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe or non-portable bundle path: ${path}`);
  }
  return parts.join('/');
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

async function copyRegularFile(source: string, destination: string): Promise<void> {
  if (!(await lstat(source)).isFile()) throw new Error(`Expected a regular file: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function copyDirectory(
  source: string,
  destination: string,
  signal?: AbortSignal,
  javascriptOnly = false,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    checkCancellation(signal);
    portableRelativePath(entry.name);
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle paths cannot contain symbolic links: ${from}`);
    if (entry.isDirectory()) {
      await copyDirectory(from, to, signal, javascriptOnly);
    } else if (entry.isFile() && (!javascriptOnly || entry.name.endsWith('.js'))) {
      await copyRegularFile(from, to);
    } else if (!entry.isFile()) {
      throw new Error(`Bundle inputs must contain only regular files and directories: ${from}`);
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
  const environment = {};
  for (const [key, value] of Object.entries(config.environment)) {
    environment[key] = value === null ? undefined : value;
  }
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
      timeoutMs: config.timeoutMs,
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
  return `# FailTrace reproduction\n\nThis directory contains the FailTrace Core engine, selected source/input files, and evidence from run \`${config.sourceRunId}\`. Creating the bundle did not execute its command.\n\n## Replay\n\n1. Install Node.js 22.12 or newer and any external tools needed by the target command. FailTrace itself needs no install or network connection.\n2. Inspect \`repro.json\`, the scripts, \`source/\`, and original evidence under \`logs/\`. The configured command runs with your permissions.\n3. Install the target project's dependencies or perform its setup inside \`source/\`, if needed. Only explicitly selected files are included; dependencies and external services are not captured automatically.\n4. Run \`node repro.mjs\` (or \`sh repro.sh\` / \`repro.cmd\`) from any directory.\n\nThe command runs from \`source/\`. It uses the original trial count, timeout, and failure predicate recorded in \`repro.json\`. The script prints how many trials matched the target predicate, so unrelated non-zero exits do not establish reproduction for a specific predicate. An exit code of 1 means the target failure was reproduced, 0 means it was not, 2 means replay could not run, and 130/143 mean interruption. New evidence is written under \`replay-artifacts/runs/\`; original logs remain unchanged.\n\nExplicit environment overrides (or the original explicitly selected snapshot) appear in \`repro.json\`; null unsets a variable. Other variables are inherited from the replay environment. Check these values for secrets or machine-specific paths before sharing. ${config.input ? 'The selected input is under `input/`; replay sets `' + (config.input.kind === 'file' ? 'FAILTRACE_INPUT' : 'FAILTRACE_INPUT_DIR') + '` to its new location automatically.' : 'No separate input was selected.'}\n\n## Portability limits\n\nThe engine is included under \`engine/\` and uses Node.js built-ins. Target commands retain their shell syntax and may require platform-specific tools, dependency installation, environment variables, or external state. Original evidence may contain private output and absolute paths from the source machine. The bundle does not reconstruct unselected files or uncaptured environment state. Inspect and supply a portable command in \`repro.json\` as necessary. Process-tree cleanup remains best effort.\n`;
}

/** Build a local, self-contained replay directory without executing its command. */
export async function createBundle(options: BundleOptions): Promise<BundleResult> {
  checkCancellation(options.signal);
  const cwd = resolve(options.cwd ?? process.cwd());
  const run = await loadRun(options.run, cwd);
  const command = options.command ?? run.command;
  assertPortableCommand(command, run.cwd);
  const files = [...new Set((options.files ?? []).map(portableRelativePath))].sort();
  const sourceRoot = files.length > 0 && run.source?.kind !== 'git' ? await realpath(run.cwd) : resolve(run.cwd);
  if (run.source?.kind !== 'git') {
    for (const file of files) {
      const source = join(sourceRoot, file);
      await assertNoSymlinks(source, sourceRoot);
      if (!(await lstat(source)).isFile()) throw new Error(`Selected source must be a regular file: ${file}`);
    }
  }
  const environment = { ...(options.env ?? run.environment?.variables ?? {}) };
  for (const [key, value] of Object.entries(environment)) {
    if (!key || key.includes('=') || key.includes('\0') || (value !== null && (typeof value !== 'string' || value.includes('\0')))) {
      throw new Error(`Invalid bundle environment override: ${key}`);
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
  try {
    checkCancellation(options.signal);
    await mkdir(join(directory, 'source'));
    for (const file of files) {
      checkCancellation(options.signal);
      if (run.source?.kind === 'git') {
        await copyGitSourceFile(run.source, file, join(directory, 'source', file), options.signal);
      } else {
        await copyRegularFile(join(sourceRoot, file), join(directory, 'source', file));
      }
    }
    const config: ReproductionConfig = {
      schemaVersion: 1,
      failtraceVersion: run.failtraceVersion,
      sourceRunId: run.id,
      command,
      repeat: run.requestedTrials,
      timeoutMs: run.timeoutMs,
      predicate: run.predicate ?? { kind: 'nonzero_exit' },
      sourceDirectory: 'source',
      artifactsDirectory: 'replay-artifacts',
      environment,
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
        await copyDirectory(input, join(directory, 'input'), options.signal);
        config.input = { path: 'input', kind: 'directory' };
      } else if (info.isFile()) {
        const filename = portableRelativePath(basename(input));
        await copyRegularFile(input, join(directory, 'input', filename));
        config.input = { path: `input/${filename}`, kind: 'file' };
      } else {
        throw new Error('Bundle input must be a regular file or directory.');
      }
      delete environment.FAILTRACE_INPUT;
      delete environment.FAILTRACE_INPUT_DIR;
    }
    const evidencePaths = new Set(['run.json']);
    for (const trial of run.trials) {
      evidencePaths.add(trial.stdoutPath);
      evidencePaths.add(trial.stderrPath);
      evidencePaths.add(`${dirname(trial.stdoutPath).replaceAll('\\', '/')}/result.json`);
    }
    for (const path of evidencePaths) {
      checkCancellation(options.signal);
      const source = await safeArtifactPath(run.artifactDirectory, path);
      await copyRegularFile(source, join(directory, 'logs', portableRelativePath(path)));
    }
    await copyDirectory(engineDirectory, join(directory, 'engine'), options.signal, true);
    await writeFile(join(directory, 'engine', 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
    const license = await readFile(resolve(engineDirectory, '../../LICENSE'), 'utf8');
    await writeFile(join(directory, 'engine', 'LICENSE'), license, { flag: 'wx' });
    await writeFile(join(directory, 'repro.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
    await writeFile(join(directory, 'README.md'), bundleReadme(config), { flag: 'wx' });
    await writeFile(join(directory, 'repro.mjs'), REPLAY_SCRIPT, { flag: 'wx' });
    await writeFile(join(directory, 'repro.sh'), '#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2\nexec node "$SCRIPT_DIR/repro.mjs"\n', { flag: 'wx' });
    await chmod(join(directory, 'repro.sh'), 0o755);
    await writeFile(join(directory, 'repro.cmd'), '@echo off\r\nnode "%~dp0repro.mjs"\r\nexit /b %errorlevel%\r\n', { flag: 'wx' });
    checkCancellation(options.signal);
    return { id, directory, configPath: join(directory, 'repro.json'), sourceRunId: run.id, files };
  } catch (error) {
    // Only remove the fresh, exclusive directory created by this operation.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

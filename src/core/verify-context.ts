import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runGit } from './git.js';
import { safeArtifactPath } from './run-reader.js';

/** Explicit scope: an empty list means no files declared in that category. */
export interface ContextCaptureOptions {
  inputFiles?: string[];
  setupFiles?: string[];
  sourceFiles?: string[];
}
export interface ContextDeclaration {
  inputFiles: string[];
  setupFiles: string[];
  sourceFiles: string[];
}
export interface FileIdentity { path: string; bytes: number; sha256: string }
export interface ContextSnapshot {
  inputs: FileIdentity[];
  setup: FileIdentity[];
  sourceFiles: FileIdentity[];
  source: { kind: 'git'; commit: string; patchSha256: string; subdirectory: string; tracked: FileIdentity[]; deleted: string[]; untracked: FileIdentity[] }
    | { kind: 'files' } | { kind: 'unknown' };
  issues: string[];
}
export interface RunContext {
  schemaVersion: 1;
  /** Canonical working directory; it must be supplied again explicitly to Verify. */
  workingDirectory: string;
  declaration: ContextDeclaration;
  before: ContextSnapshot;
  after?: ContextSnapshot;
  stable: boolean;
}

const MAX_FILES = 10_000;
const MAX_BYTES = 512 * 1024 * 1024;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function fileList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error('Context files must be an array of at most 10000 relative paths.');
  const paths = value.map((entry: unknown) => {
    if (typeof entry !== 'string' || !entry || entry.includes('\0') || isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) {
      throw new Error('Context files must be relative paths inside cwd.');
    }
    const path = entry.replaceAll('\\', '/');
    if (path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe context file path.');
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new Error('Context file paths must be unique within each category.');
  return paths.sort();
}

export function contextDeclaration(value: ContextCaptureOptions): ContextDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Context capture must be an object.');
  return { inputFiles: fileList(value.inputFiles), setupFiles: fileList(value.setupFiles), sourceFiles: fileList(value.sourceFiles) };
}

/** Stream contents; reject symlinks and a file changing while it is being read. */
async function hashFile(root: string, path: string, budget: { bytes: number; files: number }, signal: AbortSignal): Promise<FileIdentity> {
  signal.throwIfAborted();
  if (++budget.files > MAX_FILES) throw new Error('Context exceeds the 10000 file limit.');
  const filename = await safeArtifactPath(root, path);
  const before = await stat(filename, { bigint: true });
  if (!before.isFile()) throw new Error('Context paths must reference regular files.');
  const bytes = Number(before.size);
  if (budget.bytes + bytes > MAX_BYTES) throw new Error('Context exceeds the 512 MiB hashing limit.');
  const hash = createHash('sha256');
  let read = 0;
  for await (const chunk of createReadStream(filename, { signal })) {
    read += (chunk as Buffer).length;
    budget.bytes += (chunk as Buffer).length;
    if (budget.bytes > MAX_BYTES) throw new Error('Context exceeds the 512 MiB hashing limit.');
    hash.update(chunk as Buffer);
  }
  const after = await stat(await safeArtifactPath(root, path), { bigint: true });
  if (read !== bytes || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || before.ino !== after.ino || before.dev !== after.dev) {
    throw new Error('A context file changed during hashing.');
  }
  return { path, bytes, sha256: hash.digest('hex') };
}

function contains(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`));
}

/** No content, patch text, repository path or ambient environment is persisted here. */
export async function captureContext(
  cwd: string, declaration: ContextDeclaration, excludedDirectory?: string, signal?: AbortSignal,
): Promise<ContextSnapshot> {
  const snapshot: ContextSnapshot = { inputs: [], setup: [], sourceFiles: [], source: { kind: 'unknown' }, issues: [] };
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const budget = { bytes: 0, files: 0 };
  try {
    const root = await realpath(cwd);
    for (const [key, files] of [
      ['inputs', declaration.inputFiles], ['setup', declaration.setupFiles], ['sourceFiles', declaration.sourceFiles],
    ] as const) {
      for (const path of files) snapshot[key].push(await hashFile(root, path, budget, boundedSignal));
    }
    // A declared source scope is deliberate, including workspaces inside an
    // enclosing repository's ignored artifacts. Do not add unrelated Git files.
    if (declaration.sourceFiles.length) { snapshot.source = { kind: 'files' }; return snapshot; }
    let repository: string;
    try {
      repository = await realpath(await runGit(root, ['rev-parse', '--show-toplevel'], { signal: boundedSignal }));
    } catch (error) {
      // Explicit source files can identify an experiment outside a Git repository.
      if (/not a git repository|Unable to run Git:.*ENOENT/i.test(String(error)) && !boundedSignal.aborted) {
        snapshot.source = declaration.sourceFiles.length ? { kind: 'files' } : { kind: 'unknown' };
        if (snapshot.source.kind === 'unknown') snapshot.issues.push('No Git revision or declared source files identify this experiment.');
        return snapshot;
      }
      throw error;
    }
    const subdirectory = relative(repository, root).split(sep).join('/');
    if (!contains(repository, root)) throw new Error('Git working directory is outside its repository.');
    const revision = async (): Promise<string> => runGit(repository, ['rev-parse', '--verify', 'HEAD^{commit}'], { signal: boundedSignal });
    const patch = async (): Promise<string> => runGit(repository,
      ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', '--ignore-submodules=none', 'HEAD', '--'], { signal: boundedSignal });
    const untrackedPaths = async (): Promise<string[]> => {
      const output = await runGit(repository, ['ls-files', '--others', '--exclude-standard', '-z'], { signal: boundedSignal });
      const paths = output.split('\0').filter(Boolean).filter((path) => {
        const absolute = resolve(repository, path);
        // Generated evidence cannot turn a read-only experiment into a source change.
        return !path.replaceAll('\\', '/').split('/').includes('.failtrace')
          && !(excludedDirectory && contains(resolve(excludedDirectory), absolute));
      });
      return fileList(paths);
    };
    const commit = await revision();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Git did not return an immutable commit.');
    const patchSha256 = digest(await patch());
    const trackedState = async (): Promise<string> => runGit(repository, ['ls-files', '--stage', '-v', '-z'], { signal: boundedSignal });
    const indexState = await trackedState();
    const entries = indexState.split('\0').filter(Boolean);
    if (entries.some((entry) => entry[0] === 'S' || /^[a-z]/.test(entry))) {
      throw new Error('Automatic Git context cannot identify assume-unchanged or skip-worktree files; declare source files or clear those flags.');
    }
    const trackedPaths: string[] = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      const header = entry.slice(0, tab).split(' ');
      if (tab < 0 || !['100644', '100755'].includes(header[1] ?? '') || header[3] !== '0') {
        throw new Error('Automatic Git context requires regular tracked files without submodules, symlinks or unresolved merges; declare source files.');
      }
      trackedPaths.push(entry.slice(tab + 1));
    }
    // A clean filter or newline normalization can hide changed working-tree
    // bytes from git diff. Hash actual files as well as recording Git identity.
    const tracked: FileIdentity[] = [];
    const deleted: string[] = [];
    for (const path of fileList(trackedPaths)) {
      try { tracked.push(await hashFile(repository, path, budget, boundedSignal)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        deleted.push(path); // An intentionally deleted tracked file is a known source change.
      }
    }
    const paths = await untrackedPaths();
    const untracked: FileIdentity[] = [];
    for (const path of paths) untracked.push(await hashFile(repository, path, budget, boundedSignal));
    if (commit !== await revision() || patchSha256 !== digest(await patch()) || indexState !== await trackedState()
      || JSON.stringify(paths) !== JSON.stringify(await untrackedPaths())) throw new Error('Git context changed during capture.');
    snapshot.source = { kind: 'git', commit, patchSha256, subdirectory, tracked, deleted, untracked };
  } catch (error) {
    // Error details can contain private filesystem locations; retain a useful
    // category without copying command output or absolute paths into provenance.
    const message = error instanceof Error ? error.message : '';
    const ownMessages = /^(Context exceeds|Context paths must|A context file changed|Git context changed|Automatic Git context cannot)/;
    snapshot.issues.push(boundedSignal.aborted ? 'Context capture was interrupted or exceeded 30 seconds.'
      : ownMessages.test(message) ? message
      : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'A declared context file is missing.'
      : 'Context could not be captured completely. Check declared regular files and local Git availability.');
  }
  return snapshot;
}

export function snapshotsEqual(a: ContextSnapshot, b: ContextSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate untrusted stored provenance before using its file declarations. */
export function validRunContext(value: unknown): value is RunContext {
  try {
    if (!value || typeof value !== 'object') return false;
    const context = value as RunContext;
    if (context.schemaVersion !== 1 || typeof context.stable !== 'boolean'
      || typeof context.workingDirectory !== 'string' || !isAbsolute(context.workingDirectory)) return false;
    const declaration = contextDeclaration(context.declaration);
    if (JSON.stringify(declaration) !== JSON.stringify(context.declaration)) return false;
    const validFiles = (items: FileIdentity[], paths?: string[]): boolean => Array.isArray(items)
      && items.length <= MAX_FILES && items.every((item) => item && typeof item === 'object'
        && typeof item.path === 'string' && fileList([item.path])[0] === item.path
        && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && /^[a-f0-9]{64}$/.test(item.sha256))
      && new Set(items.map((item) => item.path)).size === items.length
      && (!paths || JSON.stringify(items.map((item) => item.path)) === JSON.stringify(paths));
    const validSnapshot = (snapshot: ContextSnapshot): boolean => {
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.issues)
        || snapshot.issues.some((issue) => typeof issue !== 'string')
        || !validFiles(snapshot.inputs, declaration.inputFiles) || !validFiles(snapshot.setup, declaration.setupFiles)
        || !validFiles(snapshot.sourceFiles, declaration.sourceFiles) || !snapshot.source) return false;
      if (snapshot.source.kind === 'files') return declaration.sourceFiles.length > 0;
      if (snapshot.source.kind === 'unknown') return true;
      const source = snapshot.source;
      return snapshot.source.kind === 'git' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.source.commit)
        && /^[a-f0-9]{64}$/.test(snapshot.source.patchSha256)
        && (snapshot.source.subdirectory === '' || fileList([snapshot.source.subdirectory])[0] === snapshot.source.subdirectory)
        && validFiles(snapshot.source.tracked) && validFiles(snapshot.source.untracked)
        && Array.isArray(snapshot.source.deleted) && JSON.stringify(fileList(snapshot.source.deleted)) === JSON.stringify(snapshot.source.deleted)
        && new Set([...source.deleted, ...source.tracked.map((file) => file.path)]).size === source.deleted.length + source.tracked.length;
    };
    return validSnapshot(context.before) && (context.after === undefined || validSnapshot(context.after));
  } catch { return false; }
}

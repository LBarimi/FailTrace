import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, opendir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { copyBoundedFile, hashBoundedFile } from './bounded-file.js';
import { copyGitSourceFile } from './git-source.js';
import { MAX_METADATA_BYTES } from './metadata-budget.js';
import type { RunSummary } from './types.js';

export const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 10_000;
const MAX_DEPTH = 64;
export type BundleFileCategory = 'source' | 'input' | 'evidence' | 'engine' | 'replay';
export interface BundleFileEntry { path: string; category: BundleFileCategory; bytes: number; sha256: string }

export function portableRelativePath(path: string): string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\0')) {
    throw new Error('Bundle files must be relative paths inside the original working directory.');
  }
  const parts = path.replaceAll('\\', '/').split('/').filter((part) => part !== '.');
  if (parts.length === 0 || parts.length > MAX_DEPTH || parts.some((part) => !part || part === '..' || /[\u0000-\u001f<>:"|?*]/.test(part)
    || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe or non-portable bundle path, or more than 64 path levels.');
  }
  return parts.join('/');
}

/** One exclusive bundle, with a shared copy allowance and a content inventory. */
export class BundleWriter {
  readonly files: BundleFileEntry[] = [];
  totalBytes = 0;
  private readonly paths = new Set<string>();
  private readonly spelling = new Map<string, string>();
  private treeEntries = 0;
  constructor(private readonly root: string, readonly maxBytes: number) {}

  private checkPath(path: string): string {
    path = portableRelativePath(path);
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const previous = this.spelling.get(prefix.toLowerCase());
      if (previous !== undefined && previous !== prefix) throw new Error('Bundle paths collide on a case-insensitive filesystem.');
      this.spelling.set(prefix.toLowerCase(), prefix);
    }
    return path.toLowerCase();
  }

  private reserve(path: string, bytes: number): void {
    const canonical = this.checkPath(path);
    if (this.paths.has(canonical)) throw new Error('Bundle paths collide on a case-insensitive filesystem.');
    if (this.paths.size >= MAX_BUNDLE_FILES) throw new Error('Bundle exceeds the 10000 file limit.');
    if (bytes > this.maxBytes - this.totalBytes) throw new Error('Bundle exceeds maxBundleBytes; select fewer files or increase the explicit allowance.');
    this.paths.add(canonical);
    this.totalBytes += bytes;
  }

  async file(source: string, path: string, category: BundleFileCategory, signal?: AbortSignal): Promise<void> {
    path = portableRelativePath(path);
    const destination = join(this.root, path);
    const info = await lstat(source);
    if (info.size > this.maxBytes - this.totalBytes) throw new Error('Bundle exceeds maxBundleBytes; select fewer files or increase the explicit allowance.');
    await mkdir(dirname(destination), { recursive: true });
    let reserved = 0;
    await copyBoundedFile(source, destination, this.maxBytes - this.totalBytes, (bytes) => {
      this.reserve(path, bytes); reserved = bytes;
    }, signal);
    await chmod(destination, info.mode & 0o777);
    const identity = await hashBoundedFile(destination, reserved, signal);
    if (identity.bytes !== reserved) throw new Error('Copied bundle file changed before inventory.');
    this.files.push({ path, category, ...identity });
  }

  async git(source: NonNullable<RunSummary['source']>, file: string, signal?: AbortSignal): Promise<void> {
    const path = portableRelativePath(`source/${file}`);
    const destination = join(this.root, path);
    let reserved = 0;
    await copyGitSourceFile(source, file, destination, signal, (bytes) => { this.reserve(path, bytes); reserved = bytes; });
    const identity = await hashBoundedFile(destination, reserved, signal);
    if (identity.bytes !== reserved) throw new Error('Exported bundle file changed before inventory.');
    this.files.push({ path, category: 'source', ...identity });
  }

  async directory(source: string, path: string, category: BundleFileCategory, signal?: AbortSignal, javascriptOnly = false): Promise<void> {
    path = portableRelativePath(path);
    this.checkPath(path);
    if (!(await lstat(source)).isDirectory()) throw new Error('Bundle tree must be a regular directory without symbolic links.');
    await mkdir(join(this.root, path), { recursive: true });
    const entries = [];
    for await (const entry of await opendir(source)) {
      if (++this.treeEntries > MAX_BUNDLE_FILES) throw new Error('Bundle exceeds the 10000 directory-entry limit.');
      entries.push(entry);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (portableRelativePath(entry.name) !== entry.name) throw new Error('Unsafe or non-portable bundle directory entry.');
      const from = join(source, entry.name);
      const to = portableRelativePath(`${path}/${entry.name}`);
      if (entry.isDirectory()) await this.directory(from, to, category, signal, javascriptOnly);
      else if (entry.isFile()) {
        if (!javascriptOnly || entry.name.endsWith('.js')) await this.file(from, to, category, signal);
      } else throw new Error('Bundle paths cannot contain symbolic links or special files.');
    }
  }

  async text(path: string, text: string, category: BundleFileCategory): Promise<void> {
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_METADATA_BYTES) throw new Error('Generated bundle document exceeds the 32 MiB limit.');
    this.reserve(path, bytes);
    await mkdir(dirname(join(this.root, path)), { recursive: true });
    await writeFile(join(this.root, path), text, { flag: 'wx' });
    this.files.push({ path, category, bytes, sha256: createHash('sha256').update(text).digest('hex') });
  }
}

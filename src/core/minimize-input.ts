import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type MinimizeFormat = 'text' | 'json' | 'files' | 'env';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Candidate =
  | { format: 'text'; text: string }
  | { format: 'json'; text: string; value: JsonValue }
  | { format: 'files'; files: string[] }
  | { format: 'env'; values: Record<string, string> };

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

async function collectFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`Input directory contains a symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...await collectFiles(path, join(prefix, name)));
    else if (entry.isFile()) files.push(join(prefix, name));
    else throw new Error(`Input contains an unsupported special file: ${path}`);
  }
  return files;
}

/** Validate the complete source tree before creating any minimization artifacts. */
export async function readMinimizeInput(inputPath: string, format: MinimizeFormat, cwd: string): Promise<Candidate> {
  const entry = await lstat(inputPath);
  if (entry.isSymbolicLink()) throw new Error('Minimization input must not be a symbolic link.');
  const canonicalCwd = await realpath(cwd);
  const canonicalInput = await realpath(inputPath);
  const artifactsParent = join(canonicalCwd, '.failtrace', 'minimizations');
  for (const path of [join(canonicalCwd, '.failtrace'), artifactsParent]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Minimization artifact directories must not be symbolic links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (contains(artifactsParent, canonicalInput) || (format === 'files' && contains(canonicalInput, artifactsParent))) {
    throw new Error('Input must not overlap the minimization artifact directory. Use a dedicated input directory.');
  }
  if (format === 'files') {
    if (!entry.isDirectory()) throw new Error('Files input must be a dedicated directory.');
    return { format, files: await collectFiles(inputPath) };
  }
  if (!entry.isFile()) throw new Error(`${format} input must be a regular file.`);
  const text = await readFile(inputPath, 'utf8');
  if (format === 'text') return { format, text };
  let value: JsonValue;
  try { value = JSON.parse(text) as JsonValue; }
  catch { throw new Error(`${format} input must contain valid JSON.`); }
  if (format === 'json') return { format, value, text };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Environment input must be a JSON object of string variable values.');
  }
  const names = new Set<string>();
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.includes('\0')) {
      throw new Error('Environment input requires portable variable names and string values without null bytes.');
    }
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
    if (names.has(normalized)) throw new Error('Environment input contains duplicate case-insensitive variable names.');
    if (['FAILTRACE_INPUT', 'FAILTRACE_INPUT_DIR', 'FAILTRACE_TRIAL_INDEX'].includes(key.toUpperCase())) {
      throw new Error(`Environment input cannot select reserved variable ${key}.`);
    }
    names.add(normalized);
  }
  return { format: 'env', values: value as Record<string, string> };
}

export function candidateSize(candidate: Candidate): number {
  if (candidate.format === 'text') return Array.from(candidate.text).length;
  if (candidate.format === 'files') return candidate.files.length;
  if (candidate.format === 'env') return Object.keys(candidate.values).length;
  const count = (value: JsonValue): number => value !== null && typeof value === 'object'
    ? 1 + Object.values(value).reduce<number>((sum, child) => sum + count(child), 0)
    : 1;
  return count(candidate.value);
}

export function inputName(format: MinimizeFormat): string {
  return format === 'files' ? 'files' : format === 'text' ? 'input.txt' : 'input.json';
}

/** Materialize only inside a newly owned destination; originals are always read-only. */
export async function writeCandidate(candidate: Candidate, path: string, originalDirectory: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (candidate.format !== 'files') {
    const text = candidate.format === 'env' ? `${JSON.stringify(candidate.values, null, 2)}\n` : candidate.text;
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  await mkdir(path);
  for (const file of candidate.files) {
    const source = resolve(originalDirectory, file);
    const destination = resolve(path, file);
    if (!contains(originalDirectory, source) || !contains(path, destination)) throw new Error('Input file escaped its directory.');
    if (!(await lstat(source)).isFile()) throw new Error(`Input file changed or became a symbolic link: ${source}`);
    await mkdir(dirname(destination), { recursive: true });
    // Reflinks preserve mutation isolation; Node falls back to copying when unavailable.
    await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  }
}

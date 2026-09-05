import { lstat, mkdir, opendir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { copyBoundedFile, readBoundedFile } from './bounded-file.js';
import { DEFAULT_MAX_INPUT_BYTES, MAX_ENV_KEYS, MAX_INPUT_DEPTH, MAX_INPUT_ENTRIES, MAX_INPUT_FILES, type CandidateStorageBudget } from './input-budget.js';
import { assertJsonComplexity, textUnits } from './input-complexity.js';

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

async function collectFiles(directory: string, maxBytes: number): Promise<string[]> {
  const files: string[] = [];
  let bytes = 0;
  let entries = 0;
  const visit = async (folder: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_INPUT_DEPTH) throw new Error('Input directory exceeds the 64 level depth limit.');
    for await (const { name } of await opendir(folder)) {
      if (++entries > MAX_INPUT_ENTRIES) throw new Error('Input exceeds the 10000 directory-entry limit, including empty directories.');
      const path = join(folder, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw new Error(`Input directory contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path, join(prefix, name), depth + 1);
      else if (entry.isFile()) {
        bytes += entry.size;
        if (bytes > maxBytes) throw new Error(`Input exceeds the ${maxBytes} byte directory limit.`);
        if (files.length >= MAX_INPUT_FILES) throw new Error('Input exceeds the 10000 file limit.');
        files.push(join(prefix, name));
      } else throw new Error(`Input contains an unsupported special file: ${path}`);
    }
  };
  await visit(directory, '', 0);
  return files.sort();
}

/** Validate the complete source tree before creating any minimization artifacts. */
export async function readMinimizeInput(inputPath: string, format: MinimizeFormat, cwd: string, maxBytes = DEFAULT_MAX_INPUT_BYTES): Promise<Candidate> {
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
    return { format, files: await collectFiles(inputPath, maxBytes) };
  }
  if (!entry.isFile()) throw new Error(`${format} input must be a regular file.`);
  const text = (await readBoundedFile(inputPath, maxBytes)).toString('utf8');
  if (format === 'text') { textUnits(text); return { format, text }; }
  assertJsonComplexity(text);
  let value: JsonValue;
  try { value = JSON.parse(text) as JsonValue; }
  catch { throw new Error(`${format} input must contain valid JSON.`); }
  if (format === 'json') return { format, value, text };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Environment input must be a JSON object of string variable values.');
  }
  const names = new Set<string>();
  for (const [key, item] of Object.entries(value)) {
    if (names.size >= MAX_ENV_KEYS) throw new Error('Environment input exceeds the 10000 key limit.');
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
  if (candidate.format === 'text') return textUnits(candidate.text);
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
export async function writeCandidate(candidate: Candidate, path: string, originalDirectory: string, budget?: CandidateStorageBudget, maxBytes = DEFAULT_MAX_INPUT_BYTES): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (candidate.format !== 'files') {
    const text = candidate.format === 'env' ? `${JSON.stringify(candidate.values, null, 2)}\n` : candidate.text;
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error(`Encoded candidate exceeds the ${maxBytes} byte input limit.`);
    budget?.reserve(bytes);
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  await mkdir(path);
  let total = 0;
  for (const file of candidate.files) {
    const source = resolve(originalDirectory, file);
    const destination = resolve(path, file);
    if (!contains(originalDirectory, source) || !contains(path, destination)) throw new Error('Input file escaped its directory.');
    if (!(await lstat(source)).isFile()) throw new Error(`Input file changed or became a symbolic link: ${source}`);
    await mkdir(dirname(destination), { recursive: true });
    await copyBoundedFile(source, destination, maxBytes, (bytes) => {
      if (bytes > maxBytes - total) throw new Error(`Copied candidate exceeds the ${maxBytes} byte input limit.`);
      total += bytes;
      budget?.reserve(bytes);
    });
  }
}

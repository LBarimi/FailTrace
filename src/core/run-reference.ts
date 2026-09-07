import { lstat, opendir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const UUID_PREFIX = /^[a-f0-9]{8}(?:[a-f0-9-]{0,28})$/i;
export const MAX_RUN_LOOKUP_ENTRIES = 100_000;

export class RunReferenceError extends Error {
  constructor(message: string, readonly code = 'ENOENT') { super(message); this.name = 'RunReferenceError'; }
}

/** Shorthands only search direct run children, never another investigation's runs. */
export async function resolveRunReference(reference: string, cwd: string, signal?: AbortSignal): Promise<{ path: string; selectedId?: string }> {
  const latest = reference === 'latest' || reference === 'last';
  const local = resolve(cwd, reference);
  if (!latest) {
    try { await stat(local); return { path: local }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !/^[\w.-]+$/.test(reference)) throw error;
    }
    const exact = resolve(cwd, '.failtrace', 'runs', reference);
    try { await stat(exact); return { path: exact }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!UUID_PREFIX.test(reference)) throw new RunReferenceError('Run not found. Use a full run ID, a unique UUID prefix of at least 8 characters, latest, or a run.json path.');
    }
  }
  const storage = resolve(cwd, '.failtrace');
  const root = join(storage, 'runs');
  try {
    for (const path of [storage, root]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new RunReferenceError('Run shorthand lookup requires regular .failtrace/runs directories. Use an explicit run path.', 'EINVAL');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunReferenceError('No runs found in this project. Run a command first, check --cwd, or supply an explicit run path.');
    throw error;
  }
  let entries = 0;
  let newest: string | undefined;
  let matches = 0;
  const candidates: string[] = [];
  for await (const entry of await opendir(root)) {
    signal?.throwIfAborted();
    if (++entries > MAX_RUN_LOOKUP_ENTRIES) throw new RunReferenceError('Run lookup exceeds 100000 entries. Supply a full run ID or explicit path.', 'ERUNLOOKUPLIMIT');
    const match = RUN_ID.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (latest) {
      if (newest === undefined || entry.name > newest) newest = entry.name;
    } else if (match[1]!.startsWith(reference.toLowerCase())) {
      matches++;
      candidates.push(entry.name);
      candidates.sort();
      if (candidates.length > 8) candidates.pop();
    }
  }
  if (!latest && matches > 1) throw new RunReferenceError(`Run prefix is ambiguous (${matches} matches). Use a longer UUID prefix or full ID:\n${candidates.join('\n')}${matches > candidates.length ? '\nAdditional matches omitted.' : ''}`, 'EAMBIGUOUS');
  const id = latest ? newest : candidates[0];
  if (!id) throw new RunReferenceError('No matching run in this project. Check --cwd or supply a full run ID or path.');
  // Do not silently skip a running, incomplete or unreadable newest run.
  const path = join(root, id);
  if ((await lstat(path)).isSymbolicLink() || (await lstat(join(path, 'run.json'))).isSymbolicLink()) {
    throw new RunReferenceError('Run shorthand resolved to a symbolic link. Supply a regular run directory.', 'EINVAL');
  }
  return { path, selectedId: id };
}

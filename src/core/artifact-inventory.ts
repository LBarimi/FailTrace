import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readBoundedFile } from './bounded-file.js';
import { MAX_INVESTIGATION_METADATA_BYTES, MAX_METADATA_BYTES } from './metadata-budget.js';
import { assertJsonComplexity } from './input-complexity.js';

const namespaces = ['runs', 'bisects', 'minimizations', 'verifications', 'reproduction', 'demos'] as const;
type ArtifactKind = typeof namespaces[number] | 'unknown';
export interface ArtifactInventoryOptions {
  cwd?: string;
  /** A storage root, not an individual investigation. Defaults to .failtrace. */
  directory?: string;
  /** Traversed files and directories together. Default 20000; maximum 100000. */
  maxEntries?: number;
  /** Optional limit for a read-only storage check; does not reserve or delete bytes. */
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface ArtifactInventoryEntry {
  /** Path relative to the selected storage root. */
  path: string;
  kind: ArtifactKind;
  bytes: number;
  files: number;
  directories: number;
  /** Reported metadata state, not evidence of process liveness or deletion authority. */
  status: string | null;
  endedAt: string | null;
  complete: boolean;
  issues: string[];
  /** Known metadata links to other entries in this snapshot. */
  references: string[];
  referencedBy: string[];
  /** References outside this storage root are counted without disclosing their paths. */
  externalReferences: number;
}
export interface ArtifactInventory {
  schemaVersion: 1;
  directory: string;
  exists: boolean;
  complete: boolean;
  scannedEntries: number;
  maxEntries: number;
  /** Logical regular-file bytes, not allocated disk blocks or a filesystem quota. */
  bytes: number;
  files: number;
  metadataBytesRead: number;
  snapshot: string;
  /** Present only when maxBytes was requested. This is not a filesystem quota. */
  budget?: ArtifactStorageBudget;
  entries: ArtifactInventoryEntry[];
  issues: string[];
}

export interface ArtifactStorageBudget {
  maxBytes: number;
  /** A partial scan can show an exceeded limit, but cannot establish room remaining. */
  status: 'within_budget' | 'over_budget' | 'unknown';
}

const metadataNames = new Set(['run.json', 'bisect.json', 'result.json', 'verify.json', 'demo.json', 'repro.json']);
const referenceKeys = new Set(['artifactDirectory', 'runDirectory', 'metadataPath', 'baselineRunDirectory',
  'candidateRunDirectory', 'inputPath', 'originalPath', 'minimizedPath']);
const slash = (path: string): string => path.split(sep).join('/');
const inside = (path: string): boolean => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
const issue = (issues: string[], message: string): void => { if (!issues.includes(message)) issues.push(message); };
function owner(path: string): { path: string; kind: ArtifactKind } {
  const parts = path.split('/');
  const kind = namespaces.find(name => name === parts[0]);
  return kind && parts.length > 1 ? { path: `${kind}/${parts[1]}`, kind } : { path: parts[0]!, kind: 'unknown' };
}

/** Inspect existing storage only. Never execute commands, create directories, or grant deletion authority. */
export async function inventoryArtifacts(options: ArtifactInventoryOptions = {}): Promise<ArtifactInventory> {
  const maxEntries = options.maxEntries ?? 20_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) throw new Error('Inventory maxEntries must be between 1 and 100000.');
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) {
    throw new Error('Inventory maxBytes must be a positive safe integer.');
  }
  if (options.directory !== undefined && (typeof options.directory !== 'string' || !options.directory.trim() || options.directory.includes('\0'))) {
    throw new Error('Provide an artifact storage directory.');
  }
  options.signal?.throwIfAborted();
  const requestedCwd = resolve(options.cwd ?? process.cwd());
  const cwd = await realpath(requestedCwd);
  const requestedDirectory = resolve(requestedCwd, options.directory ?? '.failtrace');
  const fromCwd = relative(requestedCwd, requestedDirectory);
  // OS temporary-directory aliases may be part of the chosen working directory.
  // Canonicalize that base, then reject redirects within the selected storage path.
  const directory = inside(fromCwd) ? resolve(cwd, fromCwd) : resolve(cwd, options.directory ?? '.failtrace');
  const result: ArtifactInventory = { schemaVersion: 1, directory, exists: false, complete: true, scannedEntries: 0, maxEntries,
    bytes: 0, files: 0, metadataBytesRead: 0, snapshot: '', entries: [], issues: [],
    ...(options.maxBytes === undefined ? {} : { budget: { maxBytes: options.maxBytes, status: 'within_budget' } }),
  };
  options.signal?.throwIfAborted();
  // Reject links in the requested root and its ancestors, including junctions.
  const ancestors: string[] = [];
  for (let path = directory; ; path = dirname(path)) { ancestors.unshift(path); if (dirname(path) === path) break; }
  for (const path of ancestors) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return result;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Artifact storage and its ancestors must be directories without symbolic links.');
  }
  result.exists = true;
  const groups = new Map<string, ArtifactInventoryEntry>();
  const references = new Map<string, Set<string>>();
  const fingerprints: string[] = [];
  const groupFor = (path: string): ArtifactInventoryEntry => {
    const key = owner(path);
    let group = groups.get(key.path);
    if (!group) {
      group = { ...key, bytes: 0, files: 0, directories: 0, status: null, endedAt: null, complete: true,
        issues: [], references: [], referencedBy: [], externalReferences: 0 };
      groups.set(key.path, group);
    }
    return group;
  };
  const incomplete = (group: ArtifactInventoryEntry | undefined, message: string): void => {
    result.complete = false;
    issue(result.issues, message);
    if (group) { group.complete = false; issue(group.issues, message); }
  };
  const inspectMetadata = async (path: string, local: string, group: ArtifactInventoryEntry, size: number): Promise<void> => {
    if (!metadataNames.has(local.split('/').at(-1)!) || /\/trials\//.test(`/${local}`)) return;
    if (size > MAX_METADATA_BYTES || size > MAX_INVESTIGATION_METADATA_BYTES - result.metadataBytesRead) {
      incomplete(group, 'Metadata read limit reached; reference information is incomplete.'); return;
    }
    result.metadataBytesRead += size;
    try {
      const text = (await readBoundedFile(path, size, options.signal)).toString('utf8');
      // Bound parsed allocation before a compact array/object expands in memory.
      // The traversal guard below separately bounds pending reference work.
      assertJsonComplexity(text);
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid metadata.');
      const record = data as Record<string, unknown>;
      // Only an investigation's own top-level report supplies its displayed state.
      if (dirname(local).replaceAll('\\', '/') === group.path) {
        group.status = typeof record.status === 'string' && /^[a-z_]{1,40}$/.test(record.status) ? record.status : null;
        group.endedAt = typeof record.endedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(record.endedAt) ? record.endedAt : null;
      }
      const pending: Array<{ value: unknown; depth: number }> = [{ value: data, depth: 0 }];
      let visited = 0;
      const found = references.get(group.path) ?? new Set<string>();
      references.set(group.path, found);
      while (pending.length) {
        options.signal?.throwIfAborted();
        const { value, depth } = pending.pop()!;
        if (++visited > 100_000 || depth > 64) throw new Error('Metadata complexity limit.');
        if (!value || typeof value !== 'object') continue;
        visited += Object.keys(value).length;
        if (visited > 100_000) throw new Error('Metadata complexity limit.');
        for (const [key, child] of Object.entries(value)) {
          if (referenceKeys.has(key)) {
            if (typeof child !== 'string' || !child || child.length > 4096 || child.includes('\0')) incomplete(group, 'Invalid metadata references require manual review.');
            else if (isAbsolute(child)) {
              const fromRequestedRoot = relative(requestedDirectory, resolve(child));
              found.add(inside(fromRequestedRoot) ? resolve(directory, fromRequestedRoot) : resolve(child));
            }
            else incomplete(group, 'Relative metadata references require manual review.');
          }
          if (child && typeof child === 'object') {
            if (pending.length >= 100_000) throw new Error('Metadata complexity limit.');
            pending.push({ value: child, depth: depth + 1 });
          }
        }
      }
    } catch {
      options.signal?.throwIfAborted();
      incomplete(group, 'Metadata is unreadable, changed, invalid, or too complex; reference information is incomplete.');
    }
  };
  const walk = async (path: string, local: string, depth: number): Promise<void> => {
    options.signal?.throwIfAborted();
    const group = local ? groupFor(local) : undefined;
    if (depth > 64) { incomplete(group, 'Directory depth limit reached.'); return; }
    try {
      const before = await lstat(path, { bigint: true });
      fingerprints.push(JSON.stringify([local, String(before.dev), String(before.ino), String(before.size), String(before.mtimeNs), String(before.ctimeNs)]));
      if (before.isSymbolicLink()) { incomplete(group, 'Symbolic links are not followed.'); return; }
      if (before.isFile()) {
        if (before.size > BigInt(Number.MAX_SAFE_INTEGER - result.bytes)) { incomplete(group, 'Logical byte total exceeds the safe integer range.'); return; }
        const size = Number(before.size);
        result.bytes += size; result.files++;
        group!.bytes += size; group!.files++;
        await inspectMetadata(path, local, group!, size);
      } else if (before.isDirectory()) {
        if (group) group.directories++;
        for await (const entry of await opendir(path)) {
          options.signal?.throwIfAborted();
          if (result.scannedEntries >= maxEntries) { incomplete(group, 'Entry limit reached; totals are a lower bound.'); break; }
          result.scannedEntries++;
          await walk(join(path, entry.name), local ? `${local}/${entry.name}` : entry.name, depth + 1);
        }
      } else { incomplete(group, 'Special filesystem entries are not read.'); return; }
      const after = await lstat(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) incomplete(group, 'Storage changed during the scan.');
    } catch {
      options.signal?.throwIfAborted();
      incomplete(group, 'A filesystem entry could not be inspected.');
    }
  };
  await walk(directory, '', 0);
  // Namespace containers are not separate investigations unless they have direct files/issues.
  for (const kind of namespaces) {
    const container = groups.get(kind);
    if (container && container.files === 0 && container.issues.length === 0) groups.delete(kind);
  }
  for (const [source, paths] of references) {
    const group = groups.get(source)!;
    for (const path of paths) {
      const local = relative(directory, path);
      if (!inside(local)) { group.externalReferences++; continue; }
      const destination = owner(slash(local)).path;
      if (destination === source) continue;
      const target = groups.get(destination);
      if (!target) { incomplete(group, 'A referenced artifact is missing or outside the scanned entries.'); continue; }
      if (!group.references.includes(destination)) group.references.push(destination);
      if (!target.referencedBy.includes(source)) target.referencedBy.push(source);
    }
  }
  result.entries = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const group of result.entries) { group.references.sort(); group.referencedBy.sort(); }
  result.snapshot = createHash('sha256').update(fingerprints.sort().join('\n')).digest('hex');
  if (result.budget) result.budget.status = result.bytes > result.budget.maxBytes
    ? 'over_budget' : result.complete ? 'within_budget' : 'unknown';
  return result;
}

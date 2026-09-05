import { join } from 'node:path';
import { writeTextAtomic } from './artifacts.js';
import type { RunSummary } from './types.js';
import { MAX_METADATA_BYTES } from './metadata-budget.js';

/** Keep small final summaries compatible while bounding the run-level document. */
export const EMBEDDED_TRIALS_LIMIT = 1024 * 1024;
export { MAX_METADATA_BYTES } from './metadata-budget.js';

export interface StoredRunSummary extends Omit<RunSummary, 'schemaVersion'> {
  schemaVersion: 1 | 2;
  trialStorage?: 'individual';
  trialCount?: number;
}

/** Per-trial result.json files are committed before a terminal summary is written. */
export async function writeRunSummary(summary: RunSummary): Promise<number> {
  // Running/error snapshots have no count: a crash or failed metadata write can
  // leave only a subset of concurrent trial records durable on disk.
  const compact: StoredRunSummary = {
    ...summary, schemaVersion: 2, trials: [], trialStorage: 'individual',
    ...(summary.status === 'running' || summary.status === 'error' ? {} : { trialCount: summary.trials.length }),
  };
  const compactText = `${JSON.stringify(compact, null, 2)}\n`;
  // Stop estimating as soon as compact storage wins; never stringify a huge
  // trials array just to discover that it exceeds the reader's document limit.
  let estimate = Buffer.byteLength(compactText);
  if (summary.status !== 'running') {
    for (const trial of summary.trials) {
      estimate += Buffer.byteLength(JSON.stringify(trial, null, 2)) + 128;
      if (estimate > EMBEDDED_TRIALS_LIMIT) break;
    }
  }
  let text = summary.status === 'running' || estimate > EMBEDDED_TRIALS_LIMIT
    ? compactText : `${JSON.stringify(summary, null, 2)}\n`;
  if (Buffer.byteLength(text) > EMBEDDED_TRIALS_LIMIT) text = compactText;
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error('Run configuration exceeds the 32 MiB metadata limit.');
  await writeTextAtomic(join(summary.artifactDirectory, 'run.json'), text);
  return Buffer.byteLength(text);
}

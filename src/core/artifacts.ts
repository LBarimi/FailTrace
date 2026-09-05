import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_METADATA_BYTES } from './metadata-budget.js';

export async function createRunDirectory(artifactsDir: string): Promise<{ id: string; directory: string }> {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const parent = join(artifactsDir, 'runs');
  await mkdir(parent, { recursive: true });
  const directory = join(parent, id);
  await mkdir(directory);
  return { id, directory };
}

/** Replace metadata only after a complete JSON file is flushed beside it. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write already encoded metadata without serializing the same summary twice. */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error('Metadata document exceeds the 32 MiB write limit.');
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx');
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

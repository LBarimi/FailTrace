import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Hash a finite immutable snapshot without retaining its contents in memory. */
export async function hashBoundedFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  await readSnapshot(path, maxBytes, async (chunk) => { bytes += chunk.length; hash.update(chunk); }, undefined, signal);
  return { bytes, sha256: hash.digest('hex') };
}

/** Read only a finite file snapshot, rejecting growth or replacement during I/O. */
export async function readBoundedFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await readSnapshot(path, maxBytes, async (chunk) => { chunks.push(Buffer.from(chunk)); }, undefined, signal);
  return Buffer.concat(chunks);
}

/** Exclusive copy with a hard transfer bound; a target cannot enlarge the copy mid-read. */
export async function copyBoundedFile(
  source: string, destination: string, maxBytes: number, reserve?: (bytes: number) => void, signal?: AbortSignal,
): Promise<void> {
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await readSnapshot(source, maxBytes, async (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await output!.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Input copy made no progress.');
        offset += bytesWritten;
      }
    }, async (bytes) => {
      reserve?.(bytes);
      output = await open(destination, 'wx');
    }, signal);
  } finally { await output?.close(); }
}

async function readSnapshot(
  path: string, maxBytes: number, consume: (chunk: Buffer) => Promise<void>,
  begin?: (bytes: number) => Promise<void>, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!(await lstat(path)).isFile()) throw new Error('Input must be a regular file without symbolic links.');
  const input = await open(path, 'r');
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`Input exceeds the ${maxBytes} byte file limit.`);
    const size = Number(before.size);
    await begin?.(size);
    const buffer = Buffer.alloc(Math.min(64 * 1024, size + 1));
    let total = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - total + 1));
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > size) throw new Error('Input changed during its bounded read.');
      await consume(buffer.subarray(0, bytesRead));
    }
    const after = await lstat(path, { bigint: true });
    if (!after.isFile() || total !== size || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Input changed during its bounded read.');
  } finally { await input.close(); }
}

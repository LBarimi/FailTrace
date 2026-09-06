/** A header and its terminal checkpoint remain writable when trial storage fills. */
export const MAX_METADATA_BYTES = 32 * 1024 * 1024;
export const MAX_INVESTIGATION_METADATA_BYTES = 96 * 1024 * 1024;
export const MAX_RECORDED_TRIALS = 100_000;
export const MAX_CONCURRENCY = 64;
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_EVALUATIONS = 10_000;
const TRIAL_OVERHEAD_BYTES = 16 * 1024;

export interface MetadataLimit {
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
  requiredBytes: number;
}
export class MetadataLimitError extends Error {
  constructor(readonly details: MetadataLimit) {
    super('Investigation metadata allowance exhausted; existing evidence is preserved and the result is inconclusive.');
  }
}

/** Reservations happen before execution; terminal run headers have separate headroom. */
export class MetadataBudget {
  private used = 0;
  private reserved = 0;
  constructor(readonly limitBytes = MAX_INVESTIGATION_METADATA_BYTES) {}

  reserve(bytes: number): void {
    if (bytes > this.limitBytes - this.used - this.reserved) {
      throw new MetadataLimitError({ limitBytes: this.limitBytes, usedBytes: this.used, reservedBytes: this.reserved, requiredBytes: bytes });
    }
    this.reserved += bytes;
  }
  commit(reservation: number, bytes: number): void {
    if (bytes > reservation || bytes < 0 || reservation > this.reserved) throw new Error('Invalid metadata reservation accounting.');
    this.reserved -= reservation;
    this.used += bytes;
  }
}

export function trialMetadataAllowance(command: string, args?: string[]): number {
  // Includes the JSON-escaped command, bounded diagnostics, indices, paths and
  // the fixed trial/result fields. Unused reservation is returned after writing.
  return Buffer.byteLength(JSON.stringify(command)) + (args === undefined ? 0 : Buffer.byteLength(JSON.stringify({ args }, null, 2))) + TRIAL_OVERHEAD_BYTES;
}

export function diagnosticMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length <= 2048 ? text : `${text.slice(0, 2020)} [diagnostic truncated]`;
}

export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_CANDIDATE_BYTES = 256 * 1024 * 1024;
export const MAX_INPUT_FILES = 10_000;
export const MAX_INPUT_DEPTH = 64;

export interface InputLimits {
  /** Bytes in the input file or complete input directory; default 16 MiB. */
  maxInputBytes?: number;
  /** Cumulative bytes copied for original, candidates and selected input; default 256 MiB. */
  maxCandidateBytes?: number;
}
export interface CandidateStorageLimit { limitBytes: number; usedBytes: number; requestedBytes: number }
export class CandidateStorageLimitError extends Error {
  constructor(readonly details: CandidateStorageLimit) {
    super('Candidate storage budget exhausted; best available input is preserved without a final verification.');
  }
}
export function inputLimits(options: InputLimits): Required<InputLimits> {
  const limits = { maxInputBytes: options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    maxCandidateBytes: options.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer of bytes.`);
  }
  return limits;
}
export class CandidateStorageBudget {
  private used = 0;
  constructor(readonly limitBytes: number) {}
  reserve(bytes: number): void {
    if (bytes > this.limitBytes - this.used) {
      throw new CandidateStorageLimitError({ limitBytes: this.limitBytes, usedBytes: this.used, requestedBytes: bytes });
    }
    this.used += bytes;
  }
}

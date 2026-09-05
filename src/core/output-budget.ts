/** Shared by all candidate runs in one investigation. Not a process sandbox. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface OutputLimits {
  /** Combined stdout + stderr bytes retained per trial. Default: 16 MiB. */
  maxOutputBytes?: number;
  /** Combined output retained across an entire run/bisect/minimization. Default: 256 MiB. */
  maxTotalOutputBytes?: number;
}

export interface OutputLimit {
  scope: 'trial' | 'experiment';
  limitBytes: number;
}

export function outputLimits(options: OutputLimits): Required<OutputLimits> {
  const result = {
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxTotalOutputBytes: options.maxTotalOutputBytes ?? DEFAULT_MAX_TOTAL_OUTPUT_BYTES,
  };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer of bytes.`);
  }
  return result;
}

/** Claims are synchronous so concurrent streams cannot reserve the same bytes. */
export class OutputBudget {
  private used = 0;
  constructor(readonly limitBytes: number) {}

  take(requested: number): number {
    const accepted = Math.min(requested, Math.max(0, this.limitBytes - this.used));
    this.used += accepted;
    return accepted;
  }
}

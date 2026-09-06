import { MAX_COMMAND_BYTES } from './metadata-budget.js';

/** Presence of args, including [], selects direct execution without a shell. */
export interface CommandSpec { command: string; args?: string[] }
export const MAX_COMMAND_ARGS = 4096;
export const INPUT_ARGUMENT = '{input}';

export function validateCommand(command: unknown, args?: unknown): void {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) {
    throw new Error('Command must be a non-empty string without null bytes.');
  }
  if (args !== undefined && (!Array.isArray(args) || args.length > MAX_COMMAND_ARGS
    || Array.from(args).some(value => typeof value !== 'string' || value.includes('\0')))) {
    throw new Error('Arguments must be an array of at most 4096 strings without null bytes.');
  }
  const bytes = Buffer.byteLength(command) + (args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args)));
  if (bytes > MAX_COMMAND_BYTES) throw new Error('Command and arguments exceed the 64 KiB limit; use a project-owned script.');
}

/** A display/identity value, never a shell-escaped command to execute. */
export function commandIdentity(value: CommandSpec): string | { executable: string; args: string[] } {
  return value.args === undefined ? value.command : { executable: value.command, args: [...value.args] };
}

export function sameCommand(first: CommandSpec, second: CommandSpec): boolean {
  return first.command === second.command && JSON.stringify(first.args) === JSON.stringify(second.args);
}

/** Bind complete argument values only: input paths can never become shell code. */
export function bindInputArguments(args: string[], input: string): string[] {
  return args.map(value => value === INPUT_ARGUMENT ? input : value);
}

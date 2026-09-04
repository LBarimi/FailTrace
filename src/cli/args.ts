import type { BundleOptions, CompareOptions, FailurePredicate, MinimizeFormat } from '../core/index.js';

type Common = { cwd?: string; json?: boolean };
type Experiment = { command: string; repeat: number; timeoutMs: number; predicate?: FailurePredicate };
export type CliInvocation =
  | { kind: 'help' }
  | { kind: 'version' }
  | ({ kind: 'demo' } & Common)
  | ({ kind: 'run'; captureEnv?: string[] } & Common & Experiment)
  | ({ kind: 'compare' } & Common & CompareOptions)
  | ({ kind: 'bisect'; good: string; bad: string; minFailures: number } & Common & Experiment)
  | ({ kind: 'minimize'; input: string; format: MinimizeFormat; minFailures: number; maxEvaluations: number } & Common & Experiment)
  | ({ kind: 'bundle'; envFile?: string } & Common & Omit<BundleOptions, 'env' | 'signal'>)
  | { kind: 'mcp'; cwd?: string };

export function parseTimeout(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  if (!match) throw new Error('Timeout must be a positive duration, such as 500ms, 30s, or 2m.');
  const multiplier = match[2] === 'm' ? 60_000n : match[2] === 's' ? 1_000n : 1n;
  const [whole = '0', fraction = ''] = (match[1] ?? '').split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * multiplier;
  const milliseconds = numerator / scale;
  if (numerator % scale !== 0n || milliseconds <= 0n || milliseconds > 2_147_483_647n) {
    throw new Error('Timeout must resolve to whole milliseconds between 1 and 2147483647.');
  }
  return Number(milliseconds);
}

function integer(value: string, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be a safe integer between ${min} and ${max}.`);
  }
  return result;
}

const predicateFlags = ['exit-code', 'stdout-contains', 'stderr-contains', 'stdout-regex', 'stderr-regex'];
const experiments = ['command', 'repeat', 'timeout', ...predicateFlags, 'regex-flags'];
const allowed: Record<string, string[]> = {
  demo: ['cwd', 'json'],
  run: ['repeat', 'timeout', ...predicateFlags, 'regex-flags', 'capture-env', 'cwd', 'json'],
  compare: ['trial-a', 'trial-b', 'max-lines', 'max-bytes', 'cwd', 'json'],
  bisect: [...experiments, 'good', 'bad', 'min-failures', 'cwd', 'json'],
  minimize: [...experiments, 'input', 'format', 'min-failures', 'max-evaluations', 'cwd', 'json'],
  bundle: ['file', 'input', 'command', 'output', 'env-file', 'cwd', 'json'],
  mcp: ['cwd'],
};

function parsePredicate(values: Map<string, string[]>): FailurePredicate | undefined {
  const selected = predicateFlags.filter((flag) => values.has(flag));
  if (selected.length > 1) throw new Error('Choose one failure predicate.');
  const flag = selected[0];
  const regexFlags = values.get('regex-flags')?.[0];
  if (regexFlags !== undefined && flag !== 'stdout-regex' && flag !== 'stderr-regex') {
    throw new Error('--regex-flags requires --stdout-regex or --stderr-regex.');
  }
  if (flag === undefined) return undefined;
  const value = values.get(flag)![0]!;
  if (flag === 'exit-code') return { kind: 'exit_code', value: integer(value, 'Exit code', 0, 0xffff_ffff) };
  if (flag === 'stdout-contains' || flag === 'stderr-contains') {
    return { kind: flag === 'stdout-contains' ? 'stdout_contains' : 'stderr_contains', value };
  }
  if (regexFlags !== undefined && !/^[imsu]*$/.test(regexFlags)) throw new Error('Regex flags may only contain i, m, s, u.');
  try { new RegExp(value, regexFlags); } catch { throw new Error('Invalid failure regex.'); }
  return { kind: flag === 'stdout-regex' ? 'stdout_regex' : 'stderr_regex', pattern: value, ...(regexFlags === undefined ? {} : { flags: regexFlags }) };
}

export function parseArgs(argv: string[]): CliInvocation {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0] ?? ''))) return { kind: 'help' };
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0] ?? '')) return { kind: 'version' };
  const kind = argv[0] ?? '';
  const flags = allowed[kind];
  if (!flags) throw new Error(`Unknown command: ${kind}. Use "failtrace --help".`);
  if (argv.slice(1).some((value) => value === '--help' || value === '-h')) return { kind: 'help' };
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const equals = argument.indexOf('=');
    const flag = argument.slice(2, equals === -1 ? undefined : equals);
    if (!flags.includes(flag)) throw new Error(`Unexpected option: --${flag}.`);
    if (values.has(flag) && flag !== 'file') throw new Error(`Option --${flag} may only be provided once.`);
    if (flag === 'json') {
      if (equals !== -1) throw new Error('--json does not take a value.');
      values.set(flag, ['true']);
      continue;
    }
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value === '' || (equals === -1 && value.startsWith('--'))) throw new Error(`Option --${flag} requires a value.`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  const get = (name: string): string | undefined => values.get(name)?.[0];
  const required = (name: string): string => {
    const value = get(name);
    if (value === undefined) throw new Error(`Option --${name} is required.`);
    return value;
  };
  const cwd = get('cwd');
  const common: Common = { ...(cwd === undefined ? {} : { cwd }), ...(values.has('json') ? { json: true } : {}) };
  const maximum = kind === 'compare' ? 2 : kind === 'run' || kind === 'bundle' ? 1 : 0;
  if (positional.length > maximum) throw new Error('Unexpected argument. Quote the entire target command.');
  if (kind === 'mcp') return { kind, ...(cwd === undefined ? {} : { cwd }) };
  if (kind === 'demo') return { kind, ...common };
  if (kind === 'compare') {
    if (!positional[0]?.trim()) throw new Error('Provide a run ID or path to compare.');
    return {
      kind, runA: positional[0], ...common,
      ...(positional[1] === undefined ? {} : { runB: positional[1] }),
      ...(get('trial-a') === undefined ? {} : { trialA: integer(get('trial-a')!, 'Trial index') }),
      ...(get('trial-b') === undefined ? {} : { trialB: integer(get('trial-b')!, 'Trial index') }),
      ...(get('max-lines') === undefined ? {} : { maxLines: integer(get('max-lines')!, 'Max lines', 1, 10_000) }),
      ...(get('max-bytes') === undefined ? {} : { maxBytes: integer(get('max-bytes')!, 'Max bytes', 1, 1_048_576) }),
    };
  }
  if (kind === 'bundle') {
    if (!positional[0]?.trim()) throw new Error('Provide a run ID or path to bundle.');
    return {
      kind, run: positional[0], ...common,
      ...(values.has('file') ? { files: values.get('file')! } : {}),
      ...(get('input') === undefined ? {} : { input: get('input')! }),
      ...(get('command') === undefined ? {} : { command: get('command')! }),
      ...(get('output') === undefined ? {} : { destination: get('output')! }),
      ...(get('env-file') === undefined ? {} : { envFile: get('env-file')! }),
    };
  }
  const command = kind === 'run' ? positional[0] : required('command');
  if (!command?.trim() || command.includes('\0')) throw new Error('Provide one quoted target command: failtrace run "npm test".');
  const repeat = integer(get('repeat') ?? (kind === 'run' ? '10' : kind === 'bisect' ? '5' : '1'), 'Repeat');
  const timeoutMs = parseTimeout(get('timeout') ?? '30s');
  const predicate = parsePredicate(values);
  const experiment: Experiment = { command, repeat, timeoutMs, ...(predicate === undefined ? {} : { predicate }) };
  if (kind === 'run') {
    const captureEnv = get('capture-env')?.split(',').map((key) => key.trim());
    if (captureEnv?.some((key) => !key || key.includes('=') || key.includes('\0'))) throw new Error('Capture environment names must be non-empty and comma-separated.');
    return { kind, ...experiment, ...common, ...(captureEnv === undefined ? {} : { captureEnv: [...new Set(captureEnv)] }) };
  }
  const minFailures = integer(get('min-failures') ?? '1', 'Minimum failures', 1, repeat);
  if (kind === 'bisect') return { kind, ...experiment, ...common, good: required('good'), bad: required('bad'), minFailures };
  const format = get('format') ?? 'text';
  if (!['text', 'json', 'files', 'env'].includes(format)) throw new Error('Format must be text, json, files, or env.');
  return { kind: 'minimize', ...experiment, ...common, input: required('input'), format: format as MinimizeFormat, minFailures, maxEvaluations: integer(get('max-evaluations') ?? '200', 'Maximum evaluations', 2) };
}

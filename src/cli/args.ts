export type CliInvocation =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; command: string; repeat: number; timeoutMs: number };

const MAX_TIMEOUT_MS = 2_147_483_647;

export function parseTimeout(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  if (!match) {
    throw new Error('Timeout must be a positive duration, such as 500ms, 30s, or 2m.');
  }
  const multiplier = match[2] === 'm' ? 60_000n : match[2] === 's' ? 1_000n : 1n;
  const [whole = '0', fraction = ''] = (match[1] ?? '').split('.');
  // Keep decimal input exact: floating-point multiplication can turn 1.001s
  // into 1000.9999999999999ms and incorrectly reject a valid duration.
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * multiplier;
  const milliseconds = numerator / scale;
  if (numerator % scale !== 0n || milliseconds <= 0n || milliseconds > BigInt(MAX_TIMEOUT_MS)) {
    throw new Error(`Timeout must resolve to whole milliseconds between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return Number(milliseconds);
}

function parseRepeat(value: string): number {
  const repeat = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error('Repeat must be a positive safe integer.');
  }
  return repeat;
}

export function parseArgs(argv: string[]): CliInvocation {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0] ?? ''))) {
    return { kind: 'help' };
  }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0] ?? '')) {
    return { kind: 'version' };
  }
  if (argv[0] !== 'run') {
    throw new Error(`Unknown command: ${argv[0] ?? ''}. Use "failtrace run \"<command>\"".`);
  }
  if (argv.length === 2 && ['--help', '-h'].includes(argv[1] ?? '')) {
    return { kind: 'help' };
  }

  const command = argv[1];
  if (!command?.trim() || command.startsWith('--')) {
    throw new Error('Provide one quoted target command: failtrace run "npm test".');
  }
  let repeat = 10;
  let timeoutMs = 30_000;
  const seen = new Set<string>();
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--help' || argument === '-h') {
      return { kind: 'help' };
    }
    const equals = argument.indexOf('=');
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    if (flag !== '--repeat' && flag !== '--timeout') {
      throw new Error(`Unexpected argument: ${argument}. Quote the entire target command.`);
    }
    if (seen.has(flag)) {
      throw new Error(`Option ${flag} may only be provided once.`);
    }
    seen.add(flag);
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith('--')) {
      throw new Error(`Option ${flag} requires a value.`);
    }
    if (flag === '--repeat') {
      repeat = parseRepeat(value);
    } else {
      timeoutMs = parseTimeout(value);
    }
  }
  return { kind: 'run', command, repeat, timeoutMs };
}

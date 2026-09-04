#!/usr/bin/env node
import { runTrials, VERSION } from '../core/index.js';
import { parseArgs } from './args.js';
import { formatHeader, formatSummary, formatTrial, HELP } from './presentation.js';

async function main(): Promise<number> {
  const invocation = parseArgs(process.argv.slice(2));
  if (invocation.kind === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (invocation.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const controller = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals): void => {
    if (interruptedBy) return;
    interruptedBy = signal;
    process.stdout.write('\nInterrupted; saving partial results...\n');
    controller.abort();
  };
  const onSigint = (): void => interrupt('SIGINT');
  const onSigterm = (): void => interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    process.stdout.write(`${formatHeader(invocation.command, invocation.repeat, invocation.timeoutMs)}\n`);
    const summary = await runTrials({
      command: invocation.command,
      repeat: invocation.repeat,
      timeoutMs: invocation.timeoutMs,
      signal: controller.signal,
      onTrialComplete: (trial) => {
        process.stdout.write(`${formatTrial(trial, invocation.repeat)}\n`);
      },
    });
    process.stdout.write(`${formatSummary(summary)}\n`);
    if (interruptedBy) return interruptedBy === 'SIGTERM' ? 143 : 130;
    return summary.statistics.failed > 0 ? 1 : 0;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FailTrace: ${message}\nUse "failtrace --help" for usage.\n`);
  process.exitCode = 2;
});

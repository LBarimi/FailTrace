#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bisectRegression, compareRuns, createBundle, minimizeFailure, runTrials, verifyFix, VERSION } from '../core/index.js';
import { parseArgs } from './args.js';
import { formatComparison, formatDemoProgress, formatDemoResult, formatHeader, formatSummary, formatTrial, formatVerification, HELP } from './presentation.js';

async function environmentFile(path: string): Promise<Record<string, string | null>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some((item) => item !== null && typeof item !== 'string')) {
    throw new Error('Environment file must be a JSON object mapping names to strings or null.');
  }
  return value as Record<string, string | null>;
}

async function main(): Promise<number> {
  const invocation = parseArgs(process.argv.slice(2));
  if (invocation.kind === 'help') { process.stdout.write(HELP); return 0; }
  if (invocation.kind === 'version') { process.stdout.write(`${VERSION}\n`); return 0; }
  if (invocation.kind === 'mcp') {
    const { startMcpServer } = await import('../mcp/index.js');
    await startMcpServer(invocation.cwd);
    return Number(process.exitCode ?? 0);
  }

  const controller = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const print = (value: string): void => { if (!invocation.json) process.stdout.write(`${value}\n`); };
  const result = (value: unknown): void => { if (invocation.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  const interrupt = (signal: NodeJS.Signals): void => {
    if (interruptedBy) return;
    interruptedBy = signal;
    print('\nInterrupted; saving partial results...');
    controller.abort();
  };
  const onSigint = (): void => interrupt('SIGINT');
  const onSigterm = (): void => interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    let exitCode: number;
    switch (invocation.kind) {
      case 'demo': {
        const { runDemo } = await import('../demo/index.js');
        print('FailTrace demo\n\nMeasure a flaky failure, minimize its input, reject a false fix, and keep a replayable example.');
        const demo = await runDemo({
          ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
          signal: controller.signal,
          onProgress: (progress) => {
            const message = formatDemoProgress(progress);
            if (message !== undefined) print(message);
          },
        });
        print(formatDemoResult(demo));
        result(demo);
        exitCode = demo.status === 'completed' ? 0 : 2;
        break;
      }
      case 'run': {
        print(formatHeader(invocation.command, invocation.repeat, invocation.timeoutMs, invocation.concurrency));
        const summary = await runTrials({
          ...invocation, signal: controller.signal,
          onTrialComplete: (trial) => print(formatTrial(trial, invocation.repeat)),
        });
        print(formatSummary(summary));
        result(summary);
        exitCode = summary.statistics.failed > 0 ? 1 : 0;
        break;
      }
      case 'compare': {
        const comparison = await compareRuns({ ...invocation, signal: controller.signal });
        print(formatComparison(comparison));
        result(comparison);
        exitCode = 0;
        break;
      }
      case 'verify': {
        print(`FailTrace - fix verification\n\nBaseline  ${invocation.baseline}\nCommand   ${invocation.command}\nDirectory ${invocation.cwd}\n\nChecking baseline and context. Eligible candidate trials follow in completion order.\n`);
        const verification = await verifyFix({
          ...invocation, signal: controller.signal,
          onTrialComplete: (trial) => print(formatTrial(trial, invocation.repeat)),
        });
        print(formatVerification(verification));
        result(verification);
        exitCode = verification.status === 'target_not_observed' ? 0 : verification.status === 'target_observed' ? 1 : 2;
        break;
      }
      case 'bisect': {
        print(`FailTrace - regression isolation\n\nGood      ${invocation.good}\nBad       ${invocation.bad}\nCommand   ${invocation.command}\n`);
        const search = await bisectRegression({
          ...invocation, signal: controller.signal,
          onCandidate: (candidate) => {
            const matched = candidate.run.trials.filter((trial) => trial.failureMatched ?? trial.status === 'failed').length;
            print(`  ${candidate.commit.slice(0, 12)}  ${candidate.role.padEnd(9)} ${candidate.assessment}  (${candidate.run.statistics.total}/${candidate.run.requestedTrials} trials, ${matched} matches${candidate.run.decision ? '; threshold decided' : ''})`);
          },
        });
        print(`\nResult       ${search.status}\nFirst bad    ${search.firstBad ?? '-'}\nLast good    ${search.lastGood ?? '-'}${search.reason ? `\nReason       ${search.reason}` : ''}${search.cleanupError ? `\nCleanup      ${search.cleanupError}` : ''}\n\nArtifacts:\n${search.artifactDirectory}`);
        result(search);
        exitCode = search.status === 'found' && !search.cleanupError ? 0 : 2;
        break;
      }
      case 'minimize': {
        print(`FailTrace - failure minimization\n\nInput     ${invocation.input}\nFormat    ${invocation.format}\nCommand   ${invocation.command}\n`);
        const reduction = await minimizeFailure({
          ...invocation, signal: controller.signal,
          onCandidate: (candidate) => print(`  ${String(candidate.index).padStart(3, '0')}  ${candidate.phase.padEnd(9)} ${String(candidate.units).padStart(5)} units  ${candidate.assessment}${candidate.accepted ? '  accepted' : ''}`),
        });
        print([
          '', `Result          ${reduction.status}`,
          `Original units  ${reduction.originalSize}`, `Reduced units   ${reduction.minimizedSize}`,
          `Final verified  ${reduction.finalVerified ? 'yes' : 'no'}`, `Evaluations     ${reduction.evaluations.length}`,
          ...(reduction.error ? [`Reason          ${reduction.error}`] : []),
          '', 'Minimized input:', reduction.minimizedPath,
          ...(reduction.final ? ['', 'Final run:', reduction.final.runDirectory] : []),
          '', 'Artifacts:', reduction.artifactDirectory,
        ].join('\n'));
        result(reduction);
        exitCode = reduction.status === 'completed' && reduction.finalVerified ? 0 : 2;
        break;
      }
      case 'bundle': {
        const env = invocation.envFile === undefined ? undefined
          : await environmentFile(resolve(invocation.cwd ?? process.cwd(), invocation.envFile));
        const bundle = await createBundle({ ...invocation, signal: controller.signal, ...(env === undefined ? {} : { env }) });
        print(`FailTrace - reproduction bundle\n\nSource files  ${bundle.files.length}\nBundle        ${bundle.directory}\n\nReplay:\nnode "${join(bundle.directory, 'repro.mjs')}"\n\nRead the bundle README for target setup and environment requirements.`);
        result(bundle);
        exitCode = 0;
        break;
      }
    }
    return interruptedBy ? interruptedBy === 'SIGTERM' ? 143 : 130 : exitCode;
  } catch (error) {
    if (interruptedBy) return interruptedBy === 'SIGTERM' ? 143 : 130;
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

main().then((exitCode) => { process.exitCode = exitCode; }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FailTrace: ${message}\nUse "failtrace --help" for usage.\n`);
  process.exitCode = 2;
});

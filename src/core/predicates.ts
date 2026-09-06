import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FailurePredicate, RunSummary, TrialResult } from './types.js';
import { readNUnitEvidence, validateNUnitPredicate } from './nunit-report.js';

export const DEFAULT_PREDICATE: FailurePredicate = { kind: 'nonzero_exit' };
export const MAX_REGEX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function validatePredicate(predicate: FailurePredicate = DEFAULT_PREDICATE): void {
  switch (predicate.kind) {
    case 'nunit_test': return validateNUnitPredicate(predicate);
    case 'nonzero_exit': return;
    case 'exit_code':
      if (!Number.isSafeInteger(predicate.value) || predicate.value < 0 || predicate.value > 0xffff_ffff) {
        throw new Error('Failure exit code must be an integer from 0 to 4294967295.');
      }
      return;
    case 'stdout_contains': case 'stderr_contains':
      if (typeof predicate.value !== 'string' || !predicate.value.length || predicate.value.length > 1_048_576) {
        throw new Error('Failure text must contain 1 to 1048576 characters.');
      }
      return;
    case 'stdout_regex': case 'stderr_regex':
      if (typeof predicate.pattern !== 'string' || !predicate.pattern.length || predicate.pattern.length > 10_000) {
        throw new Error('Failure regex must contain 1 to 10000 characters.');
      }
      if (!/^[imsu]*$/.test(predicate.flags ?? '')) throw new Error('Regex flags may only contain i, m, s, u.');
      try { new RegExp(predicate.pattern, predicate.flags); } catch (error) {
        throw new Error(`Invalid failure regex: ${String(error)}`);
      }
      return;
    default: throw new Error('Unknown failure predicate.');
  }
}

async function contains(path: string, needle: string): Promise<boolean> {
  let tail = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    const text = tail + String(chunk);
    if (text.includes(needle)) return true;
    tail = needle.length > 1 ? text.slice(-(needle.length - 1)) : '';
  }
  return false;
}

async function matchesRegex(path: string, pattern: string, flags = ''): Promise<boolean> {
  if ((await stat(path)).size > MAX_REGEX_OUTPUT_BYTES) {
    throw new Error('Regex output exceeds 16 MiB; use a substring or a smaller target output.');
  }
  // Untrusted regular expressions must not block the main event loop or Ctrl+C.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { openSync, closeSync, fstatSync, readSync } = require('node:fs');
    const descriptor = openSync(workerData.path, 'r');
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile()) throw new Error('Regex output must be a regular file.');
      if (before.size > workerData.maxBytes) throw new Error('Regex output exceeds 16 MiB; use a substring or a smaller target output.');
      const buffer = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
        if (count === 0) throw new Error('Regex output changed while being read.');
        offset += count;
      }
      const extra = readSync(descriptor, Buffer.alloc(1), 0, 1, offset);
      const after = fstatSync(descriptor);
      if (extra !== 0 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('Regex output changed while being read.');
      }
      parentPort.postMessage(new RegExp(workerData.pattern, workerData.flags).test(buffer.toString('utf8')));
    } finally { closeSync(descriptor); }
  `, { eval: true, workerData: { path, pattern, flags, maxBytes: MAX_REGEX_OUTPUT_BYTES } });
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Failure regex exceeded its 1 second evaluation limit.')), 1_000);
      worker.once('message', (matched: boolean) => { clearTimeout(timer); resolve(matched); });
      worker.once('error', (error) => { clearTimeout(timer); reject(error); });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Failure regex worker exited with code ${code}.`));
      });
    });
  } finally {
    await worker.terminate();
  }
}

export async function matchesFailure(
  trial: TrialResult, runDirectory: string, predicate: FailurePredicate = DEFAULT_PREDICATE,
): Promise<boolean> {
  // Infrastructure outcomes are distinct from a reproduced target predicate.
  if (trial.terminationReason !== 'exit' || trial.exitCode === null || trial.spawningFailed || trial.outputLimit || trial.error) return false;
  switch (predicate.kind) {
    case 'nunit_test': {
      const evidence = await readNUnitEvidence(trial, runDirectory, predicate);
      if (evidence.outcome === 'inconclusive') throw new Error(evidence.reason);
      if (trial.unitTest !== undefined && (evidence.sha256 !== trial.unitTest.sha256 || evidence.fullName !== trial.unitTest.fullName
        || evidence.outcome !== trial.unitTest.outcome)) throw new Error('Saved NUnit report changed after capture.');
      return evidence.outcome === 'failed';
    }
    case 'nonzero_exit': return trial.exitCode !== 0;
    case 'exit_code': return trial.exitCode === predicate.value;
    case 'stdout_contains': return contains(join(runDirectory, trial.stdoutPath), predicate.value);
    case 'stderr_contains': return contains(join(runDirectory, trial.stderrPath), predicate.value);
    case 'stdout_regex': return matchesRegex(join(runDirectory, trial.stdoutPath), predicate.pattern, predicate.flags);
    case 'stderr_regex': return matchesRegex(join(runDirectory, trial.stderrPath), predicate.pattern, predicate.flags);
  }
}

/** Require clean evidence and verify any early decision against the original budget. */
export function assessRun(summary: RunSummary, minFailures = 1): 'reproduced' | 'not_reproduced' | 'inconclusive' {
  if (!Number.isSafeInteger(minFailures) || minFailures < 1 || minFailures > summary.requestedTrials) {
    throw new Error('minFailures must be between 1 and the requested trial count.');
  }
  const completed = summary.trials.length;
  if (!Number.isSafeInteger(summary.requestedTrials) || summary.requestedTrials < 1
    || summary.status !== 'completed' || summary.error !== undefined || summary.metadataLimit !== undefined
    || completed === 0 || completed > summary.requestedTrials) {
    return 'inconclusive';
  }
  let matches = 0;
  for (const [offset, trial] of summary.trials.entries()) {
    if (trial.index !== offset + 1 || trial.terminationReason !== 'exit'
      || trial.spawningFailed || trial.timedOut || trial.signal !== null || trial.error !== undefined || trial.outputLimit !== undefined
      || trial.exitCode === null || !Number.isSafeInteger(trial.exitCode) || trial.exitCode < 0
      || (summary.executionRequirement !== undefined && trial.executionMatched !== true)
      || (summary.predicate?.kind === 'nunit_test' && (!trial.unitTest || trial.unitTest.outcome === 'inconclusive'
        || trial.unitTest.fullName !== summary.predicate.fullName || (trial.unitTest.outcome === 'failed') !== trial.failureMatched))
      || !['passed', 'failed'].includes(trial.status)
      || (trial.failureMatched !== undefined && trial.failureMatched !== (trial.status === 'failed'))) {
      return 'inconclusive';
    }
    if (trial.failureMatched ?? trial.status === 'failed') matches++;
  }
  const outcome = matches >= minFailures ? 'reproduced' : 'not_reproduced';
  // A full run supports any valid threshold, independently of its original one.
  if (completed === summary.requestedTrials) return outcome;
  const decision = summary.decision;
  const remaining = summary.requestedTrials - completed;
  if (!decision || typeof decision !== 'object' || decision.minFailures !== minFailures
    || decision.completedTrials !== completed || decision.outcome !== outcome
    || (outcome === 'not_reproduced' && matches + remaining >= minFailures)) {
    return 'inconclusive';
  }
  return outcome;
}

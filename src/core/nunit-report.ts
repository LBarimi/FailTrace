import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readBoundedFile } from './bounded-file.js';
import { safeArtifactPath } from './run-reader.js';
import type { TrialResult } from './types.js';

export const MAX_TEST_REPORT_BYTES = 4 * 1024 * 1024;
export const TEST_REPORT_ARGUMENT = '{testReport}';
export interface NUnitPredicate { kind: 'nunit_test'; fullName: string; messageContains?: string }
export interface NUnitEvidence {
  format: 'nunit3';
  outcome: 'passed' | 'failed' | 'inconclusive';
  fullName: string;
  reason?: string;
  message?: string;
  counts?: { total: number; passed: number; failed: number; skipped: number; inconclusive: number };
  reportPath?: string;
  sha256?: string;
}
type Attributes = Record<string, string>;
type Counts = NonNullable<NUnitEvidence['counts']>;
const results = { Passed: 'passed', Failed: 'failed', Skipped: 'skipped', Inconclusive: 'inconclusive' } as const;
const emptyCounts = (): Counts => ({ total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0 });

export function validateNUnitPredicate(value: NUnitPredicate): void {
  if (typeof value.fullName !== 'string' || !value.fullName.trim() || value.fullName.length > 1024 || value.fullName.includes('\0')
    || (value.messageContains !== undefined && (typeof value.messageContains !== 'string' || !value.messageContains.length
      || value.messageContains.length > 1024 || value.messageContains.includes('\0')))) {
    throw new Error('NUnit requires an exact fullName (1–1024 characters) and an optional nonempty messageContains (up to 1024 characters).');
  }
}

/** Parse NUnit 3 results only. DTDs, entities beyond XML built-ins, and malformed XML are never accepted. */
export function parseNUnitReport(bytes: Uint8Array, predicate: NUnitPredicate): NUnitEvidence {
  validateNUnitPredicate(predicate);
  const base: NUnitEvidence = { format: 'nunit3', outcome: 'inconclusive', fullName: predicate.fullName };
  if (bytes.byteLength > MAX_TEST_REPORT_BYTES) return { ...base, reason: 'NUnit report exceeds the 4 MiB reader limit.' };
  const counts = emptyCounts();
  const stack: { name: string; attrs: Attributes; before: Counts }[] = [];
  let root: Attributes | undefined;
  let nodes = 0;
  let targets = 0;
  let target: Attributes | undefined;
  let message = '';
  let suiteProblem = false;
  const fail = (): never => { throw new Error('Invalid NUnit report'); };
  const checkCounts = (attrs: Attributes, actual: Counts, required: boolean): void => {
    for (const key of Object.keys(actual) as (keyof Counts)[]) {
      const value = attrs[key];
      if (value === undefined && !required) continue;
      if (value === undefined || !/^\d+$/.test(value) || Number(value) !== actual[key]) fail();
    }
  };
  try {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Ordinary commands and non-NUnit bundles need no XML parser startup or dependency loading.
    const { SaxesParser } = createRequire(import.meta.url)('saxes') as typeof import('saxes');
    const parser = new SaxesParser({ xmlns: false });
    parser.on('error', fail);
    parser.on('doctype', fail);
    parser.on('opentag', tag => {
      if (++nodes > 100000 || stack.length >= 64 || Object.keys(tag.attributes).length > 64) fail();
      const attrs = tag.attributes;
      const parent = stack.at(-1)?.name;
      if (stack.length === 0) {
        if (tag.name !== 'test-run' || root) fail();
        root = attrs;
        // Unity Test Framework 1.4.6 writes ResultState.ToString() on test-run.
        // Accept its observed aggregate spelling; individual cases still use exact NUnit results.
        if (root.result === 'Failed(Child)') root.result = 'Failed';
      }
      if (tag.name === 'test-run' && stack.length !== 0) fail();
      if (tag.name === 'test-suite' && parent !== 'test-run' && parent !== 'test-suite') fail();
      if (tag.name === 'test-case') {
        if (parent !== 'test-suite' || ++counts.total > 10000 || !attrs.fullname || attrs.fullname.length > 1024) fail();
        if (!Object.hasOwn(results, attrs.result ?? '')) fail();
        const result = results[attrs.result as keyof typeof results];
        if (!result) fail();
        counts[result]++;
        if (attrs.fullname === predicate.fullName) { targets++; target = attrs; }
      }
      if (tag.name === 'failure' && (parent !== 'test-case' && parent !== 'test-suite'
        || stack.at(-1)!.attrs.result !== 'Failed')) fail();
      if (tag.name === 'test-suite') {
        if (!Object.hasOwn(results, attrs.result ?? '')) fail();
        // A fixture setup/teardown error is not an assertion in the target test.
        if (attrs.result === 'Failed' && ((attrs.site && !['Test', 'Child'].includes(attrs.site))
          || (attrs.label && attrs.label !== 'Error'))) suiteProblem = true;
      }
      stack.push({ name: tag.name, attrs, before: { ...counts } });
    });
    const capture = (text: string): void => {
      const n = stack.length;
      if (stack[n - 1]?.name === 'message' && stack[n - 2]?.name === 'failure'
        && stack[n - 3]?.name === 'test-case' && stack[n - 3]!.attrs.fullname === predicate.fullName) message += text;
    };
    parser.on('text', capture);
    parser.on('cdata', capture);
    parser.on('closetag', () => {
      const frame = stack.pop()!;
      if (frame.name === 'test-suite') {
        const actual = emptyCounts();
        for (const key of Object.keys(actual) as (keyof Counts)[]) actual[key] = counts[key] - frame.before[key];
        checkCounts(frame.attrs, actual, false);
        if (frame.attrs.result === 'Passed' && (actual.failed || actual.inconclusive || actual.skipped)) fail();
        if (frame.attrs.result === 'Failed' && actual.failed === 0) suiteProblem = true;
      }
    });
    parser.write(xml).close();
    if (!root || stack.length) fail();
    checkCounts(root!, counts, true);
    if (!Object.hasOwn(results, root!.result ?? '') || (root!.result === 'Passed' && (counts.failed || counts.inconclusive || counts.skipped))) fail();
  } catch {
    return { ...base, reason: 'Invalid, inconsistent, unsupported or oversized NUnit 3 XML; no test outcome established.' };
  }
  const summary = { ...base, counts };
  if (targets !== 1 || !target) return { ...summary, reason: targets === 0 ? 'Target test was not present in the report.' : 'Target fullName is ambiguous; more than one test case matched.' };
  if (!['Passed', 'Failed'].includes(target.result ?? '') || (target.site && target.site !== 'Test')
    || (target.runstate && !['Runnable', 'Explicit'].includes(target.runstate))
    || (target.label && !(target.result === 'Failed' && target.label === 'Error'))) {
    return { ...summary, reason: 'Target test was skipped, invalid, incomplete or failed during setup/teardown.' };
  }
  const failed = target.result === 'Failed';
  if (suiteProblem || counts.failed !== (failed ? 1 : 0) || counts.inconclusive || counts.skipped
    || root!.result !== (failed ? 'Failed' : 'Passed')) {
    return { ...summary, reason: 'The report contains unrelated failures, skipped/inconclusive tests or a suite execution problem; isolate the target test.' };
  }
  if (failed && predicate.messageContains !== undefined && !message.includes(predicate.messageContains)) {
    return { ...summary, reason: 'Target test failed with a different failure message.' };
  }
  return { ...summary, outcome: failed ? 'failed' : 'passed', ...(message ? { message: message.slice(0, 1024) } : {}) };
}

export function testReportPath(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > 100000) throw new Error('Invalid test-report trial index.');
  return `trials/${String(index).padStart(3, '0')}/test-results.xml`;
}

export function validateNUnitEvidence(value: NUnitEvidence, index: number): void {
  if (!value || value.format !== 'nunit3' || !['passed', 'failed', 'inconclusive'].includes(value.outcome)
    || Object.keys(value).some(key => !['format', 'outcome', 'fullName', 'reason', 'message', 'counts', 'reportPath', 'sha256'].includes(key))
    || typeof value.fullName !== 'string' || !value.fullName || value.fullName.length > 1024
    || value.reportPath !== testReportPath(index)
    || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 1024))
    || (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 1024))
    || (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)))
    || (value.outcome !== 'inconclusive' && (!value.sha256 || !value.counts))) throw new Error('Invalid NUnit evidence metadata.');
  if (value.counts !== undefined) {
    const keys = ['total', 'passed', 'failed', 'skipped', 'inconclusive'] as const;
    if (!value.counts || typeof value.counts !== 'object' || Object.keys(value.counts).some(key => !(keys as readonly string[]).includes(key))
      || keys.some(key => !Number.isSafeInteger(value.counts![key]) || value.counts![key] < 0 || value.counts![key] > 10000)
      || value.counts.total !== value.counts.passed + value.counts.failed + value.counts.skipped + value.counts.inconclusive) {
      throw new Error('Invalid NUnit evidence counts.');
    }
  }
}

/** Fresh per-trial path prevents accidental reuse; report bytes are reread during Verify. */
export async function readNUnitEvidence(trial: TrialResult, directory: string, predicate: NUnitPredicate): Promise<NUnitEvidence> {
  const reportPath = testReportPath(trial.index);
  const base: NUnitEvidence = { format: 'nunit3', outcome: 'inconclusive', fullName: predicate.fullName, reportPath };
  if (trial.terminationReason !== 'exit' || trial.exitCode === null || trial.error || trial.outputLimit) {
    return { ...base, reason: 'Test command did not finish with complete execution evidence.' };
  }
  try {
    const path = await safeArtifactPath(directory, reportPath);
    const bytes = await readBoundedFile(path, MAX_TEST_REPORT_BYTES);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const evidence = parseNUnitReport(bytes, predicate);
    if (evidence.outcome === 'passed' && trial.exitCode !== 0) {
      return { ...evidence, outcome: 'inconclusive', reason: 'Target report passed but the command exited unsuccessfully.', reportPath, sha256 };
    }
    return { ...evidence, reportPath, sha256 };
  } catch {
    return { ...base, reason: 'A fresh, stable, regular NUnit report of at most 4 MiB was not available at the assigned trial path.' };
  }
}

export function nunitReportDestination(directory: string, index: number): string {
  return join(directory, testReportPath(index));
}

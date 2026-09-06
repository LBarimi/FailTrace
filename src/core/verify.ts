import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeJsonAtomic } from './artifacts.js';
import { captureEnvironment } from './environment.js';
import { matchesFailure, validatePredicate } from './predicates.js';
import { matchesExecution, validateExecutionRequirement } from './execution-evidence.js';
import { loadRun, safeArtifactPath } from './run-reader.js';
import { runTrials, validateRunOptions } from './run-trials.js';
import { captureContext, snapshotsEqual, validRunContext } from './verify-context.js';
import type { ContextSnapshot, RunContext } from './verify-context.js';
import type { EnvironmentSnapshot, ExecutionRequirement, FailurePredicate, RunOptions, RunSummary, TrialResult } from './types.js';
import { outputLimits, type OutputLimits } from './output-budget.js';
import { commandIdentity, sameCommand } from './command.js';

export type VerifyChangeField = 'command' | 'source' | 'inputs' | 'setup' | 'environment' | 'timeout' | 'concurrency' | 'outputLimits';
export interface VerifyAllowedChange { field: VerifyChangeField; reason: string }
export interface VerifyOptions extends OutputLimits {
  baseline: string;
  /** Always supplied by the current caller; saved evidence grants no execution authority. */
  command: string;
  /** Explicit current direct arguments; never inherited from recorded evidence. */
  args?: string[];
  cwd: string;
  repeat?: number;
  timeoutMs?: number;
  concurrency?: number;
  env?: NodeJS.ProcessEnv;
  healthyExitCodes?: number[];
  allowChanges?: VerifyAllowedChange[];
  signal?: AbortSignal;
  onTrialComplete?: RunOptions['onTrialComplete'];
}
export interface VerifyRunEvidence {
  id: string;
  artifactDirectory: string;
  metadataPath: string;
  requestedTrials: number;
  completedTrials: number;
  matchedTrials: number;
  healthyTrials: number;
  unhealthyTrials: number;
  infrastructureTrials: number;
  unrelatedFailureTrials: number;
  invalidEvidenceTrials: number;
  executionEvidenceMissingTrials?: number;
  context?: RunContext;
}
export interface VerifyContextChange {
  field: VerifyChangeField;
  before: unknown;
  after: unknown;
  allowed: boolean;
  reason?: string;
}
export interface BaselineEligibility { eligible: boolean; reasons: string[] }
export interface VerifyResult {
  schemaVersion: 1;
  id: string;
  status: 'target_observed' | 'target_not_observed' | 'inconclusive' | 'interrupted';
  artifactDirectory: string;
  metadataPath: string;
  startedAt: string;
  endedAt: string | null;
  baseline: VerifyRunEvidence | null;
  candidate: VerifyRunEvidence | null;
  baselineEligibility: BaselineEligibility;
  changes: VerifyContextChange[];
  reasons: string[];
  healthyExitCodes: number[];
  plan: {
    command: string; cwd: string; repeat: number; timeoutMs: number; concurrency: number;
    args?: string[];
    maxOutputBytes: number; maxTotalOutputBytes: number;
    predicate: FailurePredicate | null; captureEnv: string[];
    executionRequirement?: ExecutionRequirement;
    healthyExitCodes: number[]; allowChanges: VerifyAllowedChange[];
  };
}

function healthyCodes(value: number[] = [0]): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((code) => !Number.isSafeInteger(code) || code < 0 || code > 0xffff_ffff)) {
    throw new Error('Healthy exit codes must be a non-empty array of nonnegative exit codes.');
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function cleanExit(trial: TrialResult): boolean {
  return trial.terminationReason === 'exit' && trial.signal === null && trial.timedOut === false
    && trial.spawningFailed === false && trial.error === undefined && trial.outputLimit === undefined && Number.isSafeInteger(trial.exitCode)
    && trial.exitCode !== null && trial.exitCode >= 0 && typeof trial.failureMatched === 'boolean'
    && trial.status === (trial.failureMatched ? 'failed' : 'passed');
}

function evidence(run: RunSummary, codes: number[]): VerifyRunEvidence {
  let healthyTrials = 0;
  let infrastructureTrials = 0;
  let unrelatedFailureTrials = 0;
  let invalidEvidenceTrials = 0;
  let executionEvidenceMissingTrials = 0;
  for (const [offset, trial] of run.trials.entries()) {
    if (['signal', 'timeout', 'spawn_error', 'interrupted', 'output_limit', 'output_error'].includes(trial.terminationReason)
      || trial.timedOut === true || trial.spawningFailed === true || (trial.signal !== null && trial.signal !== undefined)
      || trial.error !== undefined || trial.outputLimit !== undefined) infrastructureTrials++;
    else if (!cleanExit(trial) || !sameCommand(trial, run) || trial.index !== offset + 1) invalidEvidenceTrials++;
    else if (!trial.failureMatched && !codes.includes(trial.exitCode!)) unrelatedFailureTrials++;
    else if (run.executionRequirement !== undefined && trial.executionMatched !== true) executionEvidenceMissingTrials++;
    else healthyTrials++;
  }
  return {
    id: run.id, artifactDirectory: run.artifactDirectory, metadataPath: join(run.artifactDirectory, 'run.json'),
    requestedTrials: run.requestedTrials, completedTrials: run.trials.length,
    matchedTrials: run.trials.filter((trial) => trial.failureMatched === true).length,
    healthyTrials, unhealthyTrials: run.trials.length - healthyTrials,
    infrastructureTrials, unrelatedFailureTrials, invalidEvidenceTrials,
    ...(run.executionRequirement === undefined ? {} : { executionEvidenceMissingTrials }),
    ...(run.context === undefined ? {} : { context: run.context }),
  };
}

function knownEnvironment(value: unknown): value is EnvironmentSnapshot {
  if (!value || typeof value !== 'object') return false;
  const env = value as EnvironmentSnapshot;
  return typeof env.platform === 'string' && typeof env.arch === 'string' && !!env.arch
    && typeof env.nodeVersion === 'string' && !!env.nodeVersion && typeof env.shell === 'string' && !!env.shell
    && !!env.variables && typeof env.variables === 'object' && !Array.isArray(env.variables)
    && Object.entries(env.variables).every(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && (val === null || typeof val === 'string'));
}

function healthReasons(run: RunSummary, codes: number[]): string[] {
  const reasons: string[] = [];
  if (run.status !== 'completed' || run.error !== undefined || !run.endedAt) reasons.push('Run did not complete cleanly.');
  if (run.metadataLimit !== undefined) reasons.push('Run exceeded its metadata allowance; the preselected sample is incomplete.');
  if (run.decision !== undefined) reasons.push('Threshold-stopped runs are not fixed-budget verification evidence.');
  if (run.trials.length !== run.requestedTrials || run.trials.some((trial, index) => trial.index !== index + 1 || !sameCommand(trial, run))) {
    reasons.push('Run does not contain every preselected trial in index order.');
  }
  const observed = evidence(run, codes);
  if (observed.infrastructureTrials || observed.invalidEvidenceTrials || observed.unrelatedFailureTrials) {
    reasons.push('Run contains an infrastructure error, unknown match data, or an unrelated unhealthy exit.');
  }
  if (!run.predicate) reasons.push('Run has no explicit recorded target predicate.');
  else { try { validatePredicate(run.predicate); } catch { reasons.push('Recorded target predicate is invalid.'); } }
  if (run.executionRequirement !== undefined) {
    try { validateExecutionRequirement(run.executionRequirement); } catch { reasons.push('Recorded execution requirement is invalid.'); }
    if (run.trials.some(trial => trial.executionMatched !== true)) reasons.push('Required execution checkpoint is missing or unknown in one or more trials.');
  }
  if (!knownEnvironment(run.environment) || run.concurrency === undefined) reasons.push('Selected environment or concurrency context is unknown.');
  if (!validRunContext(run.context)) reasons.push('Declared input, setup and source context is missing or invalid; capture a fresh baseline with captureContext.');
  else if (!run.context.stable || !run.context.after || run.context.before.source.kind === 'unknown'
    || run.context.before.issues.length || run.context.after.issues.length || !snapshotsEqual(run.context.before, run.context.after)) {
    reasons.push('Recorded context is unknown, incomplete, or changed during the run.');
  }
  return reasons;
}

/** Metadata eligibility is independently available; verify also checks the evidence files. */
export function assessBaselineEligibility(run: RunSummary, exitCodes: number[] = [0]): BaselineEligibility {
  const codes = healthyCodes(exitCodes);
  const reasons = healthReasons(run, codes);
  if (!run.trials.some((trial) => trial.failureMatched === true)) reasons.push('Baseline contains no explicit target match; capture a reproducing baseline first.');
  return { eligible: reasons.length === 0, reasons };
}

async function checkEvidenceFiles(run: RunSummary, signal?: AbortSignal): Promise<string[]> {
  try {
    for (const trial of run.trials) {
      signal?.throwIfAborted();
      const folder = `trials/${String(trial.index).padStart(3, '0')}`;
      if (trial.stdoutPath !== `${folder}/stdout.txt` || trial.stderrPath !== `${folder}/stderr.txt`) throw new Error('Invalid output path.');
      for (const path of [trial.stdoutPath, trial.stderrPath]) {
        if (!(await stat(await safeArtifactPath(run.artifactDirectory, path))).isFile()) throw new Error('Missing output file.');
      }
      if (run.predicate?.kind === 'nunit_test' && (!trial.unitTest
        || await matchesFailure(trial, run.artifactDirectory, run.predicate) !== trial.failureMatched)) {
        return ['Saved NUnit evidence is missing or no longer agrees with the recorded target outcome.'];
      }
      if (run.executionRequirement !== undefined
        && !await matchesExecution(trial, run.artifactDirectory, run.executionRequirement)) {
        return ['Required execution checkpoint could not be confirmed in the saved output.'];
      }
    }
    return [];
  } catch { return ['Trial output evidence is missing, redirected, or could not be inspected.']; }
}

function environmentIdentity(env: EnvironmentSnapshot): unknown {
  return { ...env, variables: Object.fromEntries(Object.entries(env.variables).sort(([a], [b]) => a.localeCompare(b))) };
}

function changesBetween(
  baseline: RunSummary, current: { command: string; args?: string[]; timeoutMs: number; concurrency: number; environment: EnvironmentSnapshot; context: ContextSnapshot } & Required<OutputLimits>,
  allowed: VerifyAllowedChange[],
): VerifyContextChange[] {
  const previous = baseline.context!.before;
  const pairs: [VerifyChangeField, unknown, unknown][] = [
    ['command', commandIdentity(baseline), commandIdentity(current)], ['timeout', baseline.timeoutMs, current.timeoutMs],
    ['concurrency', baseline.concurrency, current.concurrency],
    ['outputLimits', { maxOutputBytes: baseline.maxOutputBytes ?? null, maxTotalOutputBytes: baseline.maxTotalOutputBytes ?? null },
      { maxOutputBytes: current.maxOutputBytes, maxTotalOutputBytes: current.maxTotalOutputBytes }],
    ['environment', environmentIdentity(baseline.environment!), environmentIdentity(current.environment)],
    ['inputs', previous.inputs, current.context.inputs], ['setup', previous.setup, current.context.setup],
    ['source', { source: previous.source, files: previous.sourceFiles }, { source: current.context.source, files: current.context.sourceFiles }],
  ];
  return pairs.filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after)).map(([field, before, after]) => {
    const allowance = allowed.find((entry) => entry.field === field);
    return { field, before, after, allowed: !!allowance, ...(allowance ? { reason: allowance.reason } : {}) };
  });
}

/** A full-budget observation, not an assertion that a defect is eliminated. */
export async function verifyFix(options: VerifyOptions): Promise<VerifyResult> {
  options = { ...options,
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.healthyExitCodes === undefined ? {} : { healthyExitCodes: [...options.healthyExitCodes] }),
    ...(options.allowChanges === undefined ? {} : { allowChanges: structuredClone(options.allowChanges) }),
  };
  if (typeof options.cwd !== 'string' || !options.cwd.trim() || options.cwd.includes('\0')) throw new Error('Verify requires an explicit working directory.');
  if (typeof options.baseline !== 'string' || !options.baseline.trim() || options.baseline.includes('\0')) throw new Error('Verify requires a baseline run ID or path.');
  // Validate explicit execution authority before opening any saved run.
  validateRunOptions({ command: options.command, ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
    ...(options.args === undefined ? {} : { args: options.args }),
    ...outputLimits(options),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }) });
  if (options.args !== undefined) options.args = [...options.args];
  const codes = healthyCodes(options.healthyExitCodes);
  const allowed = structuredClone(options.allowChanges ?? []);
  const fields: VerifyChangeField[] = ['command', 'source', 'inputs', 'setup', 'environment', 'timeout', 'concurrency', 'outputLimits'];
  if (!Array.isArray(allowed) || allowed.some((entry) => !entry || !fields.includes(entry.field)
    || typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.length > 10_000)
    || new Set(allowed.map((entry) => entry.field)).size !== allowed.length) throw new Error('Allowed changes require unique fields and a non-empty reason.');
  const cwd = resolve(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Verify working directory must be a directory.');
  const id = randomUUID();
  const artifactDirectory = join(cwd, '.failtrace', 'verifications', id);
  await mkdir(artifactDirectory, { recursive: true });
  const report: VerifyResult = {
    schemaVersion: 1, id, status: 'inconclusive', artifactDirectory, metadataPath: join(artifactDirectory, 'verify.json'),
    startedAt: new Date().toISOString(), endedAt: null, baseline: null, candidate: null,
    baselineEligibility: { eligible: false, reasons: [] }, changes: [], reasons: [], healthyExitCodes: codes,
    plan: { command: options.command, cwd, repeat: options.repeat ?? 10, timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.args === undefined ? {} : { args: [...options.args] }),
      ...outputLimits(options),
      concurrency: options.concurrency ?? 1, predicate: null, captureEnv: [], healthyExitCodes: codes, allowChanges: structuredClone(allowed) },
  };
  await writeJsonAtomic(report.metadataPath, report);
  try {
    if (options.signal?.aborted) { report.status = 'interrupted'; report.reasons.push('Verification was interrupted before execution.'); return report; }
    let baseline: RunSummary;
    try { baseline = await loadRun(options.baseline, cwd, options.signal); } catch {
      report.reasons.push('Baseline could not be loaded. Provide a readable run ID or run.json and capture a fresh baseline if its evidence is incomplete.');
      report.baselineEligibility.reasons = [...report.reasons];
      return report;
    }
    report.baseline = evidence(baseline, codes);
    report.baselineEligibility = assessBaselineEligibility(baseline, codes);
    report.baselineEligibility.reasons.push(...await checkEvidenceFiles(baseline, options.signal));
    report.baselineEligibility.eligible = report.baselineEligibility.reasons.length === 0;
    report.reasons.push(...report.baselineEligibility.reasons);
    if (!report.baselineEligibility.eligible) return report;
    if (await realpath(cwd) !== baseline.context!.workingDirectory) {
      report.reasons.push('The explicit working directory differs from the recorded baseline directory. Capture a fresh baseline there.');
      return report;
    }
    const plan = report.plan;
    plan.repeat = options.repeat ?? baseline.requestedTrials;
    plan.timeoutMs = options.timeoutMs ?? baseline.timeoutMs;
    plan.concurrency = options.concurrency ?? baseline.concurrency!;
    Object.assign(plan, outputLimits({
      maxOutputBytes: options.maxOutputBytes ?? baseline.maxOutputBytes ?? outputLimits({}).maxOutputBytes,
      maxTotalOutputBytes: options.maxTotalOutputBytes ?? baseline.maxTotalOutputBytes ?? outputLimits({}).maxTotalOutputBytes,
    }));
    plan.predicate = structuredClone(baseline.predicate!);
    if (baseline.executionRequirement !== undefined) plan.executionRequirement = { ...baseline.executionRequirement };
    plan.captureEnv = Object.keys(baseline.environment!.variables).sort();
    const environment = captureEnvironment(plan.captureEnv, options.env);
    const context = await captureContext(cwd, baseline.context!.declaration, artifactDirectory, options.signal);
    if (context.issues.length || context.source.kind === 'unknown') {
      report.reasons.push('Candidate context could not be captured completely.', ...context.issues);
      return report;
    }
    report.changes = changesBetween(baseline, { ...plan, environment, context }, allowed);
    if (report.changes.some((change) => !change.allowed)) {
      report.reasons.push('Candidate conditions changed without an explicit allowance and reason.');
      return report;
    }
    await writeJsonAtomic(report.metadataPath, report);
    let candidate: RunSummary;
    const candidateArtifacts = join(artifactDirectory, 'candidate');
    try {
      candidate = await runTrials({
        command: plan.command, cwd, repeat: plan.repeat, timeoutMs: plan.timeoutMs, concurrency: plan.concurrency,
        ...(plan.args === undefined ? {} : { args: plan.args }),
        maxOutputBytes: plan.maxOutputBytes, maxTotalOutputBytes: plan.maxTotalOutputBytes,
        predicate: plan.predicate!, captureEnv: plan.captureEnv, captureContext: baseline.context!.declaration,
        ...(plan.executionRequirement === undefined ? {} : { executionRequirement: plan.executionRequirement }),
        artifactsDir: candidateArtifacts,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onTrialComplete === undefined ? {} : { onTrialComplete: options.onTrialComplete }),
      });
    } catch {
      report.reasons.push('Candidate execution or evidence persistence failed; inspect the preserved candidate artifacts.');
      // This directory is unique to this invocation and contains at most one run.
      try {
        const entries = await readdir(join(candidateArtifacts, 'runs'));
        if (entries.length === 1) report.candidate = evidence(await loadRun(join(candidateArtifacts, 'runs', entries[0]!)), codes);
      } catch { /* Retain the report even if the candidate manifest is incomplete. */ }
      return report;
    }
    report.candidate = evidence(candidate, codes);
    report.reasons.push(...healthReasons(candidate, codes), ...await checkEvidenceFiles(candidate, options.signal));
    if (validRunContext(candidate.context)) {
      report.changes = changesBetween(baseline, { ...plan, environment: candidate.environment!, context: candidate.context.before }, allowed);
      if (report.changes.some((change) => !change.allowed)) report.reasons.push('Candidate conditions changed without an explicit allowance and reason.');
      if (!snapshotsEqual(context, candidate.context.before)) report.reasons.push('Candidate context changed between preflight and execution.');
      if (JSON.stringify(environmentIdentity(environment)) !== JSON.stringify(environmentIdentity(candidate.environment!))) {
        report.reasons.push('Selected environment changed between preflight and execution.');
      }
    }
    if (report.reasons.length === 0) report.status = report.candidate.matchedTrials > 0 ? 'target_observed' : 'target_not_observed';
    return report;
  } finally {
    if (options.signal?.aborted) {
      report.status = 'interrupted';
      if (!report.reasons.includes('Verification was interrupted.')) report.reasons.push('Verification was interrupted.');
    }
    report.endedAt = new Date().toISOString();
    await writeJsonAtomic(report.metadataPath, report);
  }
}

import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeJsonAtomic } from './artifacts.js';
import { candidateSize, inputName, readMinimizeInput, writeCandidate, type Candidate, type JsonValue, type MinimizeFormat } from './minimize-input.js';
import { assessRun, validatePredicate } from './predicates.js';
import { DEFAULT_TIMEOUT_MS, runTrialsWithBudget, validateRunOptions, VERSION } from './run-trials.js';
import { OutputBudget, outputLimits, type OutputLimits } from './output-budget.js';
import { copyBoundedFile } from './bounded-file.js';
import { CandidateStorageBudget, CandidateStorageLimitError, inputLimits, type InputLimits, type CandidateStorageLimit } from './input-budget.js';
import type { FailurePredicate } from './types.js';
import { diagnosticMessage, MAX_EVALUATIONS, MetadataBudget, MetadataLimitError, type MetadataLimit } from './metadata-budget.js';

export type { MinimizeFormat } from './minimize-input.js';

export interface MinimizeOptions extends OutputLimits, InputLimits {
  command: string;
  input: string;
  format: MinimizeFormat;
  cwd?: string;
  repeat?: number;
  minFailures?: number;
  timeoutMs?: number;
  /** Includes baseline and final verification; must be at least two. */
  maxEvaluations?: number;
  predicate?: FailurePredicate;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onCandidate?: (evaluation: MinimizeEvaluation) => void;
}

export interface MinimizeEvaluation {
  index: number;
  phase: 'baseline' | 'candidate' | 'final';
  candidatePath: string;
  units: number;
  assessment: 'reproduced' | 'not_reproduced' | 'inconclusive';
  runDirectory: string;
  accepted: boolean;
}

export interface MinimizeResult extends OutputLimits, InputLimits {
  schemaVersion: 1;
  failtraceVersion: string;
  id: string;
  status: 'completed' | 'not_reproduced' | 'inconclusive' | 'interrupted' | 'limit_reached';
  command: string;
  format: MinimizeFormat;
  cwd: string;
  inputPath: string;
  artifactDirectory: string;
  originalPath: string;
  minimizedPath: string;
  originalSize: number;
  minimizedSize: number;
  startedAt: string;
  endedAt: string | null;
  repeat: number;
  minFailures: number;
  timeoutMs: number;
  maxEvaluations: number;
  predicate: FailurePredicate;
  finalVerified: boolean;
  storageLimit?: CandidateStorageLimit;
  metadataLimit?: MetadataLimit;
  evaluations: MinimizeEvaluation[];
  baseline?: MinimizeEvaluation;
  final?: MinimizeEvaluation;
  error?: string;
}

/** Deterministic complement-based delta debugging. Null asks it to stop immediately. */
async function reduceSequence<T>(initial: T[], accept: (candidate: T[]) => Promise<boolean | null>): Promise<T[]> {
  let current = initial;
  let granularity = 2;
  while (current.length > 0) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunkSize)];
      const accepted = await accept(candidate);
      if (accepted === null) return current;
      if (accepted) {
        current = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return current;
}

function atPath(value: JsonValue, path: (string | number)[]): JsonValue {
  let current = value;
  for (const key of path) current = (current as Record<string | number, JsonValue>)[key]!;
  return current;
}

function replaceAtPath(value: JsonValue, path: (string | number)[], replacement: JsonValue): JsonValue {
  if (path.length === 0) return replacement;
  const copy = structuredClone(value);
  const parent = atPath(copy, path.slice(0, -1)) as Record<string | number, JsonValue>;
  parent[path[path.length - 1]!] = replacement;
  return copy;
}

/** Reduce input only when the selected failure remains reproducible in completed trials. */
export async function minimizeFailure(options: MinimizeOptions): Promise<MinimizeResult> {
  const repeat = options.repeat ?? 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minFailures = options.minFailures ?? 1;
  const maxEvaluations = options.maxEvaluations ?? 200;
  validateRunOptions({ ...options, repeat, timeoutMs });
  const limits = outputLimits(options);
  const outputBudget = new OutputBudget(limits.maxTotalOutputBytes);
  const metadata = new MetadataBudget();
  const inputBounds = inputLimits(options);
  const storageBudget = new CandidateStorageBudget(inputBounds.maxCandidateBytes);
  validatePredicate(options.predicate);
  if (!Number.isSafeInteger(minFailures) || minFailures < 1 || minFailures > repeat) {
    throw new Error('minFailures must be an integer between one and repeat.');
  }
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 2 || maxEvaluations > MAX_EVALUATIONS) {
    throw new Error('maxEvaluations must be a safe integer from 2 to 10000, including baseline and final verification.');
  }
  if (!['text', 'json', 'files', 'env'].includes(options.format)) throw new Error('Unsupported minimization format.');
  if (typeof options.input !== 'string' || !options.input.trim()) throw new Error('Provide an input path.');
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory must be a directory.');
  const inputPath = resolve(cwd, options.input);
  const initial = await readMinimizeInput(inputPath, options.format, cwd, inputBounds.maxInputBytes);
  let initialBytes = 0;
  if (initial.format === 'files') {
    for (const path of initial.files) initialBytes += (await stat(join(inputPath, path))).size;
  } else initialBytes = (await stat(inputPath)).size;
  if (initialBytes > inputBounds.maxCandidateBytes) throw new Error('The original input copy exceeds maxCandidateBytes; increase the explicit storage budget.');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const artifactDirectory = join(cwd, '.failtrace', 'minimizations', id);
  await mkdir(join(cwd, '.failtrace', 'minimizations'), { recursive: true });
  await mkdir(artifactDirectory);
  const originalPath = join(artifactDirectory, 'original', inputName(options.format));
  if (initial.format === 'files') await writeCandidate(initial, originalPath, inputPath, storageBudget, inputBounds.maxInputBytes);
  else {
    await mkdir(dirname(originalPath));
    await copyBoundedFile(inputPath, originalPath, inputBounds.maxInputBytes, (bytes) => storageBudget.reserve(bytes));
  }
  const result: MinimizeResult = {
    schemaVersion: 1, failtraceVersion: VERSION, id, status: 'inconclusive', ...limits, ...inputBounds,
    command: options.command, format: options.format, cwd, inputPath, artifactDirectory,
    originalPath, minimizedPath: join(artifactDirectory, 'minimized', inputName(options.format)),
    originalSize: candidateSize(initial), minimizedSize: candidateSize(initial),
    startedAt: new Date().toISOString(), endedAt: null, repeat, minFailures, timeoutMs, maxEvaluations,
    predicate: options.predicate ?? { kind: 'nonzero_exit' }, finalVerified: false, evaluations: [],
  };
  const metadataPath = join(artifactDirectory, 'result.json');
  let current = initial;
  let bestPath = originalPath;
  let limited = false;
  let outputLimited = false;
  let sawInconclusive = false;
  const persist = async (): Promise<void> => writeJsonAtomic(metadataPath, result);

  const evaluate = async (candidate: Candidate, phase: MinimizeEvaluation['phase']): Promise<MinimizeEvaluation> => {
    const index = result.evaluations.length + 1;
    const directory = join(artifactDirectory, 'candidates', String(index).padStart(4, '0'));
    const candidatePath = join(directory, inputName(options.format));
    await writeCandidate(candidate, candidatePath, originalPath, storageBudget, inputBounds.maxInputBytes);
    const environment: NodeJS.ProcessEnv = { ...options.env };
    // Selected variables removed by a reduction must not leak back from the host.
    if (initial.format === 'env' && candidate.format === 'env') {
      for (const key of Object.keys(initial.values)) environment[key] = undefined;
      Object.assign(environment, candidate.values);
    }
    environment.FAILTRACE_INPUT = options.format === 'files' ? undefined : candidatePath;
    environment.FAILTRACE_INPUT_DIR = options.format === 'files' ? candidatePath : undefined;
    const run = await runTrialsWithBudget({
      command: options.command, repeat, timeoutMs, cwd, artifactsDir: directory,
      ...limits,
      stopWhenDecided: { minFailures },
      env: environment, predicate: result.predicate,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, outputBudget, metadata);
    if (run.status === 'resource_limited' || run.status === 'error') {
      outputLimited = true;
      limited = true;
      result.error = 'Run evidence could not be captured completely; no further candidates or final verification were executed.';
      if (run.metadataLimit) result.metadataLimit = run.metadataLimit;
    }
    const assessment = assessRun(run, minFailures);
    const evaluation: MinimizeEvaluation = {
      index, phase, candidatePath, units: candidateSize(candidate), assessment,
      runDirectory: run.artifactDirectory, accepted: phase === 'candidate' && assessment === 'reproduced',
    };
    result.evaluations.push(evaluation);
    await persist();
    options.onCandidate?.({ ...evaluation });
    return evaluation;
  };

  const accept = async (candidate: Candidate): Promise<boolean | null> => {
    if (outputLimited || options.signal?.aborted) return null;
    if (result.evaluations.length >= maxEvaluations - 1) { limited = true; return null; }
    const evaluation = await evaluate(candidate, 'candidate');
    if (evaluation.assessment === 'inconclusive') sawInconclusive = true;
    if (outputLimited) return null;
    if (evaluation.accepted) { current = candidate; bestPath = evaluation.candidatePath; }
    return evaluation.accepted;
  };

  const reduceJson = async (path: (string | number)[]): Promise<void> => {
    if (current.format !== 'json' || limited || options.signal?.aborted) return;
    const node = atPath(current.value, path);
    if (node === null || typeof node !== 'object') return;
    const keys = Array.isArray(node) ? node.map((_, index) => index) : Object.keys(node);
    await reduceSequence<string | number>(keys, async (remaining) => {
      if (current.format !== 'json') return null;
      const replacement: JsonValue = Array.isArray(node)
        ? remaining.map((key) => node[Number(key)]!)
        : Object.fromEntries(remaining.map((key) => [key, node[String(key)]!]));
      const value = replaceAtPath(current.value, path, replacement);
      return accept({ format: 'json', value, text: `${JSON.stringify(value, null, 2)}\n` });
    });
    if (current.format !== 'json') return;
    const remaining = atPath(current.value, path);
    if (remaining === null || typeof remaining !== 'object') return;
    const children = Array.isArray(remaining) ? remaining.map((_, index) => index) : Object.keys(remaining);
    for (const key of children) await reduceJson([...path, key]);
  };

  await persist();
  try {
    result.baseline = await evaluate(initial, 'baseline');
    if (result.baseline.assessment === 'reproduced' && !options.signal?.aborted) {
      if (current.format === 'text') {
        await reduceSequence(current.text.match(/[^\n]*\n|[^\n]+$/g) ?? [], (lines) => accept({ format: 'text', text: lines.join('') }));
        if (current.format === 'text') await reduceSequence(Array.from(current.text), (characters) => accept({ format: 'text', text: characters.join('') }));
      } else if (current.format === 'files') {
        await reduceSequence(current.files, (files) => accept({ format: 'files', files }));
      } else if (current.format === 'env') {
        const values = current.values;
        await reduceSequence(Object.keys(values), (keys) => accept({ format: 'env', values: Object.fromEntries(keys.map((key) => [key, values[key]!])) }));
      } else {
        let previousSize: number;
        do {
          previousSize = candidateSize(current);
          await reduceJson([]);
        } while (!limited && !options.signal?.aborted && candidateSize(current) < previousSize);
      }
    }
    await writeCandidate(current, result.minimizedPath, originalPath, storageBudget, inputBounds.maxInputBytes);
    bestPath = result.minimizedPath;
    result.minimizedSize = candidateSize(current);
    // One budget slot is always reserved for this independent final recheck.
    if (!outputLimited) result.final = await evaluate(current, 'final');
    result.finalVerified = result.baseline.assessment === 'reproduced' && result.final?.assessment === 'reproduced';
    result.status = options.signal?.aborted ? 'interrupted'
      : result.baseline.assessment !== 'reproduced' ? result.baseline.assessment
        : !result.finalVerified ? 'inconclusive'
          : limited ? 'limit_reached'
            : sawInconclusive ? 'inconclusive' : 'completed';
  } catch (error) {
    result.error = diagnosticMessage(error);
    if (error instanceof CandidateStorageLimitError || error instanceof MetadataLimitError) {
      result.status = options.signal?.aborted ? 'interrupted' : 'limit_reached';
      if (error instanceof CandidateStorageLimitError) result.storageLimit = error.details;
      else result.metadataLimit = error.details;
      result.finalVerified = false;
      result.minimizedPath = bestPath;
      result.minimizedSize = candidateSize(current);
    } else {
      throw new Error(`Minimization failed: ${result.error}\nArtifacts: ${artifactDirectory}`, { cause: error });
    }
  } finally {
    result.endedAt = new Date().toISOString();
    await persist();
  }
  return result;
}

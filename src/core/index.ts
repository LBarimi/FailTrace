export { runTrials, validateRunOptions, VERSION, DEFAULT_REPEAT, DEFAULT_TIMEOUT_MS } from './run-trials.js';
export { aggregateStatistics } from './statistics.js';
export { assessRun, validatePredicate, DEFAULT_PREDICATE } from './predicates.js';
export { loadRun } from './run-reader.js';
export { inspectRunEvidence } from './inspect.js';
export type {
  InspectRunEvidenceOptions, InspectRunEvidenceResult, InspectRunOutputOptions, InspectRunTrialsOptions,
  InspectedTrial, RunEvidenceFilter, RunOutputChunk, RunOutputStream, RunTrialPage,
} from './inspect.js';
export { compareRuns } from './compare.js';
export type { CompareOptions, ComparisonResult, ComparisonTrialEvidence, OutputComparison } from './compare.js';
export { bisectRegression } from './bisect.js';
export type { BisectOptions, BisectResult, BisectCandidate, BisectRunEvidence } from './bisect.js';
export { minimizeFailure } from './minimize.js';
export type { MinimizeOptions, MinimizeResult, MinimizeEvaluation, MinimizeFormat } from './minimize.js';
export { createBundle } from './bundle.js';
export type { BundleOptions, BundleResult, BundleManifest } from './bundle.js';
export type { BundleFileEntry, BundleFileCategory } from './bundle-files.js';
export type { BundleEnvironmentRequirement } from './bundle-environment.js';
export { DEFAULT_MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES } from './bundle-files.js';
export { verifyFix, assessBaselineEligibility } from './verify.js';
export type { VerifyOptions, VerifyResult, VerifyRunEvidence, VerifyContextChange, VerifyChangeField, VerifyAllowedChange, BaselineEligibility } from './verify.js';
export type { ContextCaptureOptions, ContextDeclaration, ContextSnapshot, FileIdentity, RunContext } from './verify-context.js';
export type { RunOptions, RunSummary, RunStatistics, TrialResult, TrialStatus, TerminationReason, FailurePredicate, EnvironmentSnapshot } from './types.js';
export { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_TOTAL_OUTPUT_BYTES } from './output-budget.js';
export type { OutputLimits, OutputLimit } from './output-budget.js';
export { DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_CANDIDATE_BYTES } from './input-budget.js';
export type { InputLimits, CandidateStorageLimit } from './input-budget.js';
export { MAX_INVESTIGATION_METADATA_BYTES, MAX_RECORDED_TRIALS, MAX_CONCURRENCY, MAX_COMMAND_BYTES, MAX_EVALUATIONS } from './metadata-budget.js';
export type { MetadataLimit } from './metadata-budget.js';

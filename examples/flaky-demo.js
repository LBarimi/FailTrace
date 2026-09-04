// FailTrace sets a one-based trial index for each target command.
const trial = Number(process.env.FAILTRACE_TRIAL_INDEX ?? '1');
if (!Number.isSafeInteger(trial) || trial < 1) {
  console.error('FAILTRACE_TRIAL_INDEX must be a positive integer.');
  process.exitCode = 2;
} else if (trial % 3 === 0) {
  console.error(`Trial ${trial}: checkout failed (deterministic demo).`);
  process.exitCode = 1;
} else {
  console.log(`Trial ${trial}: checkout passed.`);
}

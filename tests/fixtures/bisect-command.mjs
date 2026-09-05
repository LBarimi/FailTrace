import { readFileSync, writeFileSync } from 'node:fs';

const state = JSON.parse(readFileSync(new URL('./state.json', import.meta.url), 'utf8'));
if (state.setupExitCode !== undefined) {
  process.stderr.write('setup failed before target execution\n');
  process.exitCode = state.setupExitCode;
} else if (state.hang) {
  if (process.env.FAILTRACE_BISECT_READY) writeFileSync(process.env.FAILTRACE_BISECT_READY, 'ready');
  process.stdout.write('waiting\n');
  setInterval(() => {}, 1_000);
} else {
  const failed = (Number(process.env.FAILTRACE_TRIAL_INDEX) - 1) % 5 < state.failures;
  process.stdout.write(failed ? 'target signature\n' : 'healthy\n');
  process.exitCode = failed ? 7 : (state.healthyExitCode ?? 0);
}

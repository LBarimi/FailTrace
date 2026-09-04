import { readFileSync } from 'node:fs';

const mode = JSON.parse(readFileSync('release.json', 'utf8')).mode;
if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 10_000));
if (mode === 'bug' || (mode === 'rare' && process.env.FAILTRACE_TRIAL_INDEX === '3')) {
  console.error('TARGET_VERIFY_FAILURE');
  process.exitCode = 1;
} else if (mode === 'unrelated') {
  console.error('SyntaxError: unrelated setup failure');
  process.exitCode = 1;
} else if (mode === 'alternate') {
  process.exitCode = 7;
} else if (mode === 'environment') {
  console.log(process.env.FAILTRACE_VERIFY_ENV ?? 'unset');
}

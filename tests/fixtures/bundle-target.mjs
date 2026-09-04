import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.argv[2];
if (mode === 'mixed') {
  if (Number(process.env.FAILTRACE_TRIAL_INDEX) % 2 === 0) {
    console.error('EXPECTED_BUNDLE_FAILURE');
    process.exitCode = 7;
  } else {
    console.log('pass');
  }
} else if (mode === 'input') {
  const value = await readFile(process.env.FAILTRACE_INPUT, 'utf8');
  if (value.includes('NEEDLE')) console.error('EXPECTED_BUNDLE_FAILURE');
} else if (mode === 'directory') {
  const value = await readFile(join(process.env.FAILTRACE_INPUT_DIR, 'nested', 'value.txt'), 'utf8');
  if (value.includes('NEEDLE')) console.error('EXPECTED_BUNDLE_FAILURE');
} else if (mode === 'environment') {
  if (process.env.BUNDLE_VALUE === 'selected' && process.env.BUNDLE_UNSET === undefined) {
    console.error('EXPECTED_BUNDLE_FAILURE');
  }
} else {
  console.error('UNRELATED_FAILURE');
  process.exitCode = 8;
}

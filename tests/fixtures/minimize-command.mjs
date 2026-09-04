import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const mode = process.argv[2];
let matched = false;
if (mode === 'files') {
  const path = join(process.env.FAILTRACE_INPUT_DIR, 'nested', 'bug.txt');
  matched = existsSync(path) && readFileSync(path, 'utf8') === 'BUG';
} else if (mode === 'env') {
  matched = process.env.FAILTRACE_MINIMIZE_KEEP === 'yes';
  process.stdout.write(JSON.stringify({
    keepPresent: Object.hasOwn(process.env, 'FAILTRACE_MINIMIZE_KEEP'),
    noisePresent: Object.hasOwn(process.env, 'FAILTRACE_MINIMIZE_NOISE'),
  }));
} else {
  const text = readFileSync(process.env.FAILTRACE_INPUT, 'utf8');
  if (mode === 'json') {
    const input = JSON.parse(text);
    matched = input?.nested?.items?.some((item) => item?.break === true) ?? false;
  } else if (mode === 'baseline-only') {
    matched = basename(dirname(process.env.FAILTRACE_INPUT)) === '0001';
  } else if (mode === 'candidate-timeout') {
    matched = text === 'AB';
    if (text === 'B') setInterval(() => {}, 1_000);
  } else if (mode === 'timeout') {
    setInterval(() => {}, 1_000);
  } else {
    matched = text.includes('BUG');
  }
}
if (mode === 'output') {
  if (matched) process.stdout.write('TARGET FAILURE\n');
} else {
  process.exitCode = matched ? 17 : 0;
}

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, marker] = process.argv.slice(2);

switch (mode) {
  case 'pass':
    process.stdout.write('success: 안녕하세요\n');
    process.stderr.write('diagnostic output\n');
    break;
  case 'fail':
    process.stdout.write('before failure\n');
    process.stderr.write('expected failure\n');
    process.exitCode = 7;
    break;
  case 'alternate': {
    const index = Number(process.env.FAILTRACE_TRIAL_INDEX);
    process.stdout.write(`trial ${index}\n`);
    process.exitCode = index % 2 === 0 ? 7 : 0;
    break;
  }
  case 'environment':
    process.stdout.write(`${process.env.FAILTRACE_TEST_VALUE}\n${process.cwd()}\n`);
    break;
  case 'compare-mixed': {
    const index = Number(process.env.FAILTRACE_TRIAL_INDEX);
    if (index === 2) { process.stderr.write('unrelated delay\n'); setInterval(() => {}, 1_000); }
    else if (index === 3) { process.stderr.write('comparison target\n'); process.exitCode = 7; }
    else process.stdout.write('healthy\n');
    break;
  }
  case 'hang':
    process.stdout.write('started\n');
    if (marker) writeFileSync(marker, String(process.pid));
    setInterval(() => {}, 1_000);
    break;
  case 'interrupt-after-first':
    process.stdout.write(`trial ${process.env.FAILTRACE_TRIAL_INDEX}\n`);
    if (process.env.FAILTRACE_TRIAL_INDEX !== '1') {
      writeFileSync(marker, String(process.pid));
      setInterval(() => {}, 1_000);
    }
    break;
  case 'tree':
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'heartbeat', marker], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    setInterval(() => {}, 1_000);
    break;
  case 'heartbeat':
    writeFileSync(`${marker}.pid`, String(process.pid));
    appendFileSync(marker, '.');
    setInterval(() => appendFileSync(marker, '.'), 20);
    break;
  default:
    throw new Error(`Unknown fixture mode: ${mode}`);
}

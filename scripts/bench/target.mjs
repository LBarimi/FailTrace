import { setTimeout } from 'node:timers/promises';

const duration = Number(process.env.FAILTRACE_BENCH_DURATION_MS);
const bytes = Number(process.env.FAILTRACE_BENCH_OUTPUT_BYTES);
if (!Number.isSafeInteger(duration) || duration < 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
  throw new Error('Invalid benchmark target configuration.');
}
if (duration) await setTimeout(duration);
if (bytes) {
  const output = Buffer.alloc(bytes, 120);
  output.write('FAILTRACE_BENCH_MATCH', 0, Math.min(bytes, 21), 'utf8');
  await new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
}
process.exitCode = 1;

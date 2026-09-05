import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, value = '32'] = process.argv.slice(2);
const emit = (stream, data) => new Promise((resolve, reject) => stream.write(data, (error) => error ? reject(error) : resolve()));
if (mode === 'tree') {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'forever', value], { stdio: ['ignore', 'inherit', 'inherit'] });
  setInterval(() => {}, 1_000);
} else if (mode === 'forever') {
  writeFileSync(value, String(process.pid));
  while (true) await emit(process.stdout, Buffer.alloc(4096, 'x'));
} else if (mode === 'unicode') {
  await emit(process.stdout, '€TARGET');
} else {
  await emit(process.stdout, Buffer.alloc(Number(value), 'x'));
  if (mode === 'target') {
    await emit(process.stderr, 'TARGET');
    process.exitCode = 7;
  }
}

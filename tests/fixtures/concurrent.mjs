import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [directory, mode = 'ordered'] = process.argv.slice(2);
const index = Number(process.env.FAILTRACE_TRIAL_INDEX);
writeFileSync(join(directory, `started-${index}`), String(process.pid));
process.stdout.write(`index ${index}\n`);
if (mode === 'hang') {
  while (true) await setTimeout(20);
} else if (index === 1) {
  while (!existsSync(join(directory, 'release-first'))) await setTimeout(20);
} else if (index === 2) {
  while (!existsSync(join(directory, 'started-1'))) await setTimeout(20);
}

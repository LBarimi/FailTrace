import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const index = Number(process.env.FAILTRACE_TRIAL_INDEX);
if (process.argv[2] === 'hang') {
  await writeFile(`child-${index}.pid`, String(process.pid));
  setInterval(() => {}, 1_000);
} else {
  // Trial 1 can finish only after trial 2 has completed and its evidence is
  // durable. A sequential adapter cannot satisfy this handshake.
  if (index === 1) {
    const runs = join(process.cwd(), '.failtrace', 'runs');
    const deadline = Date.now() + 10_000;
    let observed = false;
    while (!observed && Date.now() < deadline) {
      for (const id of await readdir(runs)) {
        try {
          const result = JSON.parse(await readFile(join(runs, id, 'trials', '002', 'result.json'), 'utf8'));
          observed = result.index === 2 && result.exitCode === 7;
          if (observed) break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (!observed) await delay(10);
    }
    if (!observed) throw new Error('Trial 2 did not finish while trial 1 was active.');
  }
  process.stdout.write(`trial=${index}\n`);
  process.exitCode = index === 2 ? 7 : 0;
}

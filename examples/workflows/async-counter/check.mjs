import { readFile } from 'node:fs/promises';
import { createCounter } from './counter.mjs';

try {
  const { schedules } = JSON.parse(await readFile(new URL('./schedule.json', import.meta.url), 'utf8'));
  const index = Number(process.env.FAILTRACE_TRIAL_INDEX ?? '1');
  if (!Array.isArray(schedules) || !schedules.length || schedules.length > 100
    || schedules.some(schedule => !['overlap', 'serial'].includes(schedule))
    || !Number.isSafeInteger(index) || index < 1 || index > schedules.length) throw new Error('Invalid predeclared schedule.');
  const counter = createCounter();
  const schedule = schedules[index - 1];
  if (schedule === 'overlap') {
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    const first = counter.increment(ready);
    const second = counter.increment(ready);
    release();
    await Promise.all([first, second]);
  } else {
    await counter.increment(Promise.resolve());
    await counter.increment(Promise.resolve());
  }
  const lost = counter.value !== 2;
  console.log(JSON.stringify({ schedule, expected: 2, observed: counter.value }));
  console.log('COUNTER_CHECK_COMPLETED');
  if (lost) { console.error('COUNTER_UPDATE_LOST'); process.exitCode = 7; }
} catch (error) {
  console.error('COUNTER_PREPARATION_ERROR');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 125;
}

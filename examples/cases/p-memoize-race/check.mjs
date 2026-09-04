import { readFile } from 'node:fs/promises';
import { observeMemoization } from './race.mjs';

let timer;
try {
  if (process.argv.length !== 2) throw new Error('Unexpected arguments');
  const { packageName } = await import('./release.mjs');
  const versions = { 'memoize-affected': '6.0.2', 'memoize-fixed': '7.0.0' };
  if (!Object.hasOwn(versions, packageName)) throw new Error('Unknown release selection');
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve(packageName)), 'utf8'));
  if (metadata.name !== 'p-memoize' || metadata.version !== versions[packageName]) throw new Error('Unexpected dependency version');
  const { default: memoize } = await import(packageName);
  const { schedules } = JSON.parse(await readFile(new URL('./schedule.json', import.meta.url), 'utf8'));
  const index = Number(process.env.FAILTRACE_TRIAL_INDEX ?? '1');
  if (!Array.isArray(schedules) || schedules.length === 0 || schedules.length > 100
    || schedules.some(schedule => !['overlap', 'sequential'].includes(schedule))
    || !Number.isSafeInteger(index) || index < 1 || index > schedules.length) throw new Error('Invalid predeclared schedule');
  const observation = await Promise.race([
    observeMemoization(memoize, schedules[index - 1]),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Incomplete observation')), 5_000); }),
  ]);
  console.log(JSON.stringify({ version: metadata.version, trial: index, ...observation }));
  if (observation.invocations !== 1) {
    console.error('P_MEMOIZE_DUPLICATE_IN_FLIGHT');
    process.exitCode = 1;
  }
} catch {
  // Missing dependencies, unexpected versions and invalid schedules are not the race.
  console.error('CASE_SETUP_ERROR');
  process.exitCode = 2;
} finally {
  clearTimeout(timer);
}

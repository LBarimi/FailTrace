import { setImmediate as nextTurn } from 'node:timers/promises';

// Authored controlled-interleaving harness for upstream p-memoize issue #43 / PR #48.
// No upstream implementation is copied and no remote service is contacted.
export async function observeMemoization(memoize, schedule) {
  if (!['overlap', 'sequential'].includes(schedule)) throw new Error('Unknown schedule');
  let release;
  let firstStarted;
  let invocations = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { firstStarted = resolve; });
  const request = memoize(async key => {
    invocations++;
    firstStarted();
    await pending;
    return `result:${key}`;
  });
  const first = request('shared-key');
  await started;
  let second;
  if (schedule === 'overlap') {
    second = request('shared-key');
    // Drain the cache lookup's microtasks before releasing the first operation.
    // This controls ordering without relying on a guessed sleep duration.
    await nextTurn();
    release();
  } else {
    release();
    await first;
    second = request('shared-key');
  }
  const results = await Promise.all([first, second]);
  if (results.some(result => result !== 'result:shared-key')) throw new Error('Unexpected operation result');
  return { schedule, invocations, results };
}

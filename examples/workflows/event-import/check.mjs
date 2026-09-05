import { readFile } from 'node:fs/promises';
import { importEvents } from './importer.mjs';

// The checker is independent of the importer: enumerate IDs and find each
// maximum revision directly. Invalid candidates are preparation errors.
try {
  const path = process.env.FAILTRACE_INPUT ?? new URL('./events.json', import.meta.url);
  const events = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(events) || events.length === 0 || events.some(event => !event
    || typeof event.id !== 'string' || !event.id
    || !Number.isSafeInteger(event.revision) || event.revision < 1)) {
    throw new Error('Expected a nonempty array of events with an ID and positive revision.');
  }
  const actual = importEvents(events);
  const ids = [...new Set(events.map(event => event.id))];
  const lost = ids.filter(id => {
    const expected = Math.max(...events.filter(event => event.id === id).map(event => event.revision));
    const returned = actual.filter(row => row.id === id);
    return returned.length !== 1 || returned[0].revision !== expected;
  });
  // Emit only after loading input, running the importer and evaluating checks.
  console.log('IMPORT_CHECK_COMPLETED');
  if (lost.length) {
    console.error('IMPORT_REVISION_LOST');
    console.error(JSON.stringify({ entitiesWithStaleRevision: lost.length }));
    process.exitCode = 7;
  } else console.log('Latest revisions retained.');
} catch (error) {
  console.error('IMPORT_PREPARATION_ERROR');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 125;
}

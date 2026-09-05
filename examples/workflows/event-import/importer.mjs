// Authored failure fixture: a repeated entity ID can contain a newer revision.
export function importEvents(events) {
  const rows = new Map();
  for (const event of events) {
    if (!rows.has(event.id)) rows.set(event.id, event);
  }
  return [...rows.values()];
}

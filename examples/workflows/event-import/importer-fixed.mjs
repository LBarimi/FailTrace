export function importEvents(events) {
  const rows = new Map();
  for (const event of events) {
    const previous = rows.get(event.id);
    if (!previous || event.revision > previous.revision) rows.set(event.id, event);
  }
  return [...rows.values()];
}

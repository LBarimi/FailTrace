export interface BundleEnvironmentRequirement { key: string; state: 'set' | 'unset' }

/** Select captured values deliberately; omitted values become replay prerequisites. */
export function bundleEnvironment(
  captured: Record<string, string | null> = {}, include: string[] = [], overrides: Record<string, string | null> = {},
): { environment: Record<string, string | null>; requiredEnvironment: BundleEnvironmentRequirement[] } {
  if (!Array.isArray(include) || include.length > 10000
    || !captured || typeof captured !== 'object' || Array.isArray(captured)
    || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid bundle environment selection.');
  const names = new Map<string, string>();
  for (const entries of [Object.entries(captured), Object.entries(overrides)]) {
    if (entries.length > 10000) throw new Error('Bundle environment exceeds 10000 keys.');
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 256
        || (value !== null && (typeof value !== 'string' || value.includes('\0')))) throw new Error('Invalid bundle environment key or value.');
      const previous = names.get(key.toUpperCase());
      if (previous !== undefined && previous !== key) throw new Error('Bundle environment keys must not differ only by case.');
      names.set(key.toUpperCase(), key);
    }
  }
  const selected = new Map<string, string | null>();
  for (const key of include) {
    if (typeof key !== 'string' || !Object.hasOwn(captured, key)) throw new Error('includeEnv must name explicitly captured environment keys.');
    selected.set(key, captured[key]!);
  }
  for (const [key, value] of Object.entries(overrides)) selected.set(key, value);
  const requiredEnvironment = Object.entries(captured).filter(([key]) => !selected.has(key))
    .map(([key, value]): BundleEnvironmentRequirement => ({ key, state: value === null ? 'unset' : 'set' }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { environment: Object.fromEntries([...selected].sort(([a], [b]) => a.localeCompare(b))), requiredEnvironment };
}

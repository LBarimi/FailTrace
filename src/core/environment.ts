import type { EnvironmentSnapshot } from './types.js';

export function effectiveEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(result)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete result[existing];
      }
    }
    result[key] = value;
  }
  return result;
}

export function captureEnvironment(keys: string[] = [], overrides: NodeJS.ProcessEnv = {}): EnvironmentSnapshot {
  const environment = effectiveEnvironment(overrides);
  const variables: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const actual = process.platform === 'win32'
      ? Object.keys(environment).find((name) => name.toLowerCase() === key.toLowerCase()) ?? key : key;
    variables[key] = environment[actual] ?? null;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    shell: process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh',
    variables,
  };
}

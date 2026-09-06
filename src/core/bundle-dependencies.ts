import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BundleWriter } from './bundle-files.js';

/** Fixed Core XML dependencies only; no package install or arbitrary dependency traversal at replay. */
export async function copyCoreDependencies(writer: BundleWriter, signal?: AbortSignal): Promise<void> {
  const require = createRequire(import.meta.url);
  const packages = [
    { name: 'saxes', files: ['saxes.js', 'README.md'] },
    { name: 'xmlchars', files: ['xmlchars.js', 'xml/1.0/ed5.js', 'xml/1.1/ed2.js', 'xmlns/1.0/ed3.js', 'LICENSE'] },
  ];
  for (const { name, files } of packages) {
    const root = dirname(require.resolve(`${name}/package.json`));
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string; main: string; license: string };
    for (const file of files) await writer.file(join(root, file), `node_modules/${name}/${file}`, 'engine', signal);
    // saxes distributes its ISC license in README.md; xmlchars has LICENSE.
    await writer.text(`node_modules/${name}/package.json`, JSON.stringify({ name: metadata.name, version: metadata.version,
      main: metadata.main, license: metadata.license }) + '\n', 'engine');
  }
}

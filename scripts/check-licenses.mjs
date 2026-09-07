// Offline release check. License texts are reviewed inputs, never fetched by CI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function renderNotices(packages) {
  const rows = packages.map(p => `| ${p.name} | ${p.version} | ${p.license} | [Full notice](${p.file}) · [Source](${p.source}) |`).join('\n');
  return `# Third-party notices

FailTrace's own code is covered by [LICENSE](LICENSE). Its runtime dependencies retain their respective licenses and copyright notices. The complete notices linked below are included in the npm package and GitHub release archive.

This inventory covers the direct and transitive runtime versions reviewed in the release lockfile. npm installs these dependencies separately; installations may resolve newer compatible versions, whose own notices also apply.

| Package | Reviewed version | License information | Notice and origin |
| --- | --- | --- | --- |
${rows}

The MCP SDK notice contains its MIT-to-Apache-2.0 transition terms and documentation licensing. Preserve the entire notice; the package metadata's MIT label alone does not describe it fully. Both SDK packages use the same notice.

The saxes notice comes from its version 6.0.0 source tag because that npm archive omits the license file. Its complete upstream notice, including inherited and historical notices, is preserved here.

## Development tools

TypeScript, Vitest, Node.js type definitions and the MCP test client are development dependencies. The optional image renderer is a maintainer tool. Their code and installed dependency directories are not included in the FailTrace release archive. Preserve their licenses if redistributing those tools separately.

## Updating this inventory

When runtime dependencies change, review their exact distributed license and NOTICE files, retain the applicable texts in docs/licenses, and update the versions, source links and SHA-256 digests in [the manifest](docs/licenses/manifest.json). Do not infer a license solely from package metadata. Run node scripts/check-licenses.mjs --write to regenerate this index, then npm run check:licenses and npm run test:package. These checks cover the inventory and shipped notice files; they do not replace review of changed upstream terms.
`;
}

async function checkLicenses(root, { writeIndex = false } = {}) {
  const readJson = async file => JSON.parse(await readFile(join(root, file), 'utf8'));
  const inventory = await readJson('docs/licenses/manifest.json');
  assert.equal(inventory.schemaVersion, 1, 'Unsupported license inventory schema');
  assert(Array.isArray(inventory.packages) && inventory.packages.length > 0, 'Empty license inventory');
  const identities = new Set();
  for (const entry of inventory.packages) {
    assert(typeof entry.name === 'string' && typeof entry.version === 'string' && typeof entry.license === 'string', 'Incomplete license entry');
    const identity = `${entry.name}@${entry.version}`;
    assert(!identities.has(identity), `Duplicate license entry: ${identity}`);
    identities.add(identity);
    assert(/^docs\/licenses\/[a-z0-9-]+\.txt$/.test(entry.file), 'Invalid license file path');
    assert(/^https:\/\//.test(entry.source), 'License origin must be an HTTPS URL');
    const body = await readFile(join(root, entry.file));
    assert.equal(createHash('sha256').update(body).digest('hex'), entry.sha256, `License digest differs: ${entry.name}`);
  }
  const manifest = await readJson('package.json');
  assert(manifest.files.includes('THIRD_PARTY_NOTICES.md') && manifest.files.includes('docs'), 'Package must include third-party notices and license texts');
  const lock = await readJson('package-lock.json');
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'Runtime dependency declarations differ from lockfile');
  const expected = new Set(Object.entries(lock.packages).filter(([path, p]) => path && !p.dev)
    .map(([path, p]) => `${p.name ?? path.split('node_modules/').at(-1)}@${p.version}`));
  assert.deepEqual([...identities].sort(), [...expected].sort(), 'Runtime license coverage differs from lockfile');
  const index = renderNotices(inventory.packages);
  if (writeIndex) await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), index);
  else assert.equal((await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')).replaceAll('\r\n', '\n'), index, 'Third-party notice index is stale');
  return inventory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length <= 1, 'Usage: node scripts/check-licenses.mjs [--write | repository-directory]');
  const root = resolve(args[0] && args[0] !== '--write' ? args[0] : join(dirname(fileURLToPath(import.meta.url)), '..'));
  const inventory = await checkLicenses(root, { writeIndex: args[0] === '--write' });
  console.log(`Third-party notices checked: ${inventory.packages.length} runtime packages, complete texts and package inclusion.`);
}

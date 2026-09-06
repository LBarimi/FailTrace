// Offline documentation/release consistency checks. Historical records keep their versions.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const failures = [];
const fail = (path, message) => failures.push(`${path}: ${message}`);
const read = path => readFile(join(root, path), 'utf8');
const json = async path => JSON.parse(await read(path));
const historical = new Set(['CHANGELOG.md', 'docs/RELEASE-VALIDATION.md', 'docs/IMPLEMENTATION.md', 'docs/MIGRATING-TO-1.md']);
const manifest = await json('package.json');
const version = manifest.version;
// A release may be prepared before npm publication. Install examples must keep
// using the explicitly documented public package until its successor is verified.
const installVersion = (await read('docs/INSTALL.md')).match(/published version used here is \*\*(\d+\.\d+\.\d+)\*\*/)?.[1];
if (!installVersion) throw new Error('docs/INSTALL.md must declare its published install version.');
const releaseParts = version.split(/[.-]/).slice(0, 3).map(Number);
const installParts = installVersion.split('.').map(Number);
const difference = installParts.map((part, i) => part - releaseParts[i]).find(value => value !== 0) ?? 0;
if (difference > 0) fail('docs/INSTALL.md', 'published install version cannot be newer than the source package');
const lock = await json('package-lock.json');
const server = await json('server.json');
const runtime = (await read('src/core/run-trials.ts')).match(/export const VERSION = '([^']+)'/)?.[1];
for (const [path, value] of [['package-lock.json', lock.version], ['package-lock.json root package', lock.packages?.['']?.version],
  ['server.json', server.version], ['runtime VERSION', runtime]]) {
  if (value !== version) fail(path, `expected ${version}, found ${value}`);
}
if (server.name !== manifest.mcpName) fail('server.json', 'MCP identity differs from package.json');
if (!server.packages?.some(p => p.registryType === 'npm' && p.identifier === manifest.name)) fail('server.json', 'missing npm package');
for (const entry of server.packages ?? []) {
  if (entry.registryType === 'npm' && entry.identifier === manifest.name && entry.version !== version) fail('server.json', 'npm package version differs');
}

const docs = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'AGENTS.md'];
async function collect(directory) {
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    if (item.isDirectory()) await collect(`${directory}/${item.name}`);
    else if (item.name.endsWith('.md')) docs.push(`${directory}/${item.name}`);
  }
}
await collect('docs');
const pages = new Map(await Promise.all(docs.map(async path => [path, await read(path)])));
// GitHub heading IDs for this repository's plain Markdown headings, including duplicates.
function anchors(markdown) {
  const counts = new Map(), result = new Set();
  const plain = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of plain.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const seen = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1); result.add(slug + (seen ? `-${seen}` : ''));
  }
  for (const match of plain.matchAll(/<(?:a|span)\s+[^>]*(?:id|name)="([^"]+)"/g)) result.add(match[1]);
  return result;
}
for (const [path, markdown] of pages) {
  if (!historical.has(path)) {
    for (const match of markdown.matchAll(/\bfailtrace@([\w.+-]+)/g)) {
      if (match[1] !== installVersion) fail(path, `installation pin ${match[1]} differs from ${installVersion}`);
    }
    for (const match of markdown.matchAll(/github\.com\/LBarimi\/FailTrace\/releases\/(?:tag|download)\/v([\w.+-]+)|io\.github\.LBarimi%2Ffailtrace\/versions\/([\w.+-]+)/g)) {
      if ((match[1] ?? match[2]) !== installVersion) fail(path, 'release link version differs from the published install version');
    }
    for (const match of markdown.matchAll(/failtrace-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.tgz/g)) {
      if (match[1] !== installVersion) fail(path, 'archive filename version differs from the published install version');
    }
  }
  // Skip fenced command examples; validate prose links and images without contacting websites.
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
    const [name, fragment] = link.split('#');
    const destination = resolve(root, dirname(path), decodeURIComponent(name || path.split('/').at(-1)));
    const local = relative(root, destination).replaceAll('\\', '/');
    if (local.startsWith('../')) { fail(path, `link escapes repository: ${link}`); continue; }
    try {
      const contents = await readFile(destination);
      if (fragment && local.endsWith('.md') && !anchors(contents.toString('utf8')).has(decodeURIComponent(fragment))) fail(path, `missing heading: ${link}`);
    } catch (error) {
      if (error.code === 'EISDIR' || error.code === 'EPERM') {
        try { await readdir(destination); continue; } catch { /* report below */ }
      }
      fail(path, `missing local link: ${link}`);
    }
  }
}
const recording = await json('docs/assets/demo-recording.json');
if (recording.version !== installVersion) fail('demo recording', 'recorded CLI version differs from install examples; regenerate the assets');
for (const name of ['demo.gif', 'demo-poster.png', 'demo.svg']) {
  const bytes = await readFile(join(root, 'docs/assets', name));
  if (createHash('sha256').update(bytes).digest('hex') !== recording.sha256?.[name]) fail(name, 'asset digest differs; regenerate the recording');
  if (name === 'demo.gif' && bytes.length >= 1024 * 1024) fail(name, 'README GIF must remain below 1 MiB');
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Documentation checked: ${pages.size} pages, installation pins, package/runtime/MCP versions, local links and demo assets.`);

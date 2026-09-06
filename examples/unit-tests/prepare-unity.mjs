// Creates a new isolated example; never overlays an existing Unity project.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length > 3) throw new Error('Usage: node prepare-unity.mjs [new-project-directory]');
const destination = resolve(process.argv[2] ?? '.failtrace/unity-unit-tests');
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination); // Exclusive: an existing destination is an error.
const tests = join(destination, 'Assets', 'FailTraceTests');
await mkdir(tests, { recursive: true });
await mkdir(join(destination, 'Packages'));
await mkdir(join(destination, 'ProjectSettings'));
const source = join(dirname(fileURLToPath(import.meta.url)), 'unity');
for (const file of ['Inventory.cs', 'InventoryTests.cs', 'FailTrace.Example.Tests.asmdef']) {
  await copyFile(join(source, file), join(tests, file));
}
await writeFile(join(destination, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {
  'com.unity.test-framework': '1.4.6', 'com.unity.modules.jsonserialize': '1.0.0',
} }, null, 2) + '\n');
await writeFile(join(destination, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.48f1\n');
await writeFile(join(destination, 'items.json'), '{"items":[101,202,303]}\n');
console.log('Created isolated Unity example: ' + destination);
console.log('Target: FailTraceExample.InventoryTests.SaveRoundTripPreservesItems');
console.log('The initial test intentionally fails; docs/UNIT-TESTS.md describes the candidate fix.');

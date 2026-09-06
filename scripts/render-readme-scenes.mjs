// Record the installed CLI/MCP first, then render only checked fields and fixture text.
// Optional Sharp is a maintainer tool; neither it nor the MCP client ships as a new runtime dependency.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { colors as c, mono, text, windowFrame } from './media/window.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  assert(['--cli', '--sharp'].includes(flag) && process.argv[i + 1] && !options[flag],
    'Usage: node scripts/render-readme-scenes.mjs [--cli installed/dist/cli/index.js] [--sharp sharp-package-directory]');
  options[flag] = resolve(process.argv[i + 1]);
}
const sharp = createRequire(join(root, '.failtrace/media-tools/package.json'))(options['--sharp'] ?? 'sharp');
const cli = options['--cli'] ?? join(root, 'dist/cli/index.js');
const execute = promisify(execFile);
const invoke = args => execute(process.execPath, [cli, ...args], { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
const version = (await invoke(['--version'])).stdout.trim();
assert(/^\d+\.\d+\.\d+$/.test(version));
const parent = join(root, '.failtrace/readme-media');
await mkdir(parent, { recursive: true });
const evidence = await mkdtemp(join(parent, 'recording-'));
const project = join(evidence, 'project');
await mkdir(project);
await writeFile(join(project, 'package.json'), '{"type":"module","private":true}\n');
for (const name of ['advanced-demo.js', 'advanced-demo-implementation.js', 'advanced-input.json']) {
  await copyFile(join(root, 'examples', name), join(project, name));
}
const client = new Client({ name: 'failtrace-readme-recorder', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--cwd', project], cwd: project, stderr: 'pipe' });
const diagnostics = [];
client.onerror = error => diagnostics.push(error.message);
transport.stderr?.on('data', data => diagnostics.push(data.toString('utf8')));
const transcript = [];
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  transcript.push({ name, arguments: args, result });
  assert(!result.isError, 'The recorded MCP call must succeed; inspect private transcript.');
  assert(result.structuredContent);
  return result.structuredContent;
};
let listing, baseline, output, fixed, unitBaseline, unitFixed, unitSkipped, skippedTrial;
const fullName = 'FailTraceExample.InventoryTests.SaveRoundTripPreservesItems';
try {
  await client.connect(transport);
  listing = await client.listTools();
  assert.deepEqual(listing.tools.map(tool => tool.name).sort(), ['failtrace_bisect', 'failtrace_bundle', 'failtrace_compare',
    'failtrace_inspect_run', 'failtrace_minimize', 'failtrace_run', 'failtrace_verify']);
  baseline = await call('failtrace_run', { command: process.execPath, args: ['advanced-demo.js'], repeat: 2,
    predicate: { kind: 'stderr_contains', value: 'BUG reproduced' },
    captureContext: { sourceFiles: ['advanced-demo.js', 'advanced-demo-implementation.js'], inputFiles: ['advanced-input.json'] } });
  assert.equal(baseline.matchedTrials, 2);
  output = await call('failtrace_inspect_run', { view: 'output', run: baseline.artifactDirectory, trial: 1, stream: 'stderr', maxBytes: 128 });
  assert.equal(output.text.trim(), 'BUG reproduced: checkout received BUG');
  await copyFile(join(root, 'examples/advanced-demo-fixed.js'), join(project, 'advanced-demo-implementation.js'));
  fixed = await call('failtrace_verify', { baseline: baseline.artifactDirectory, command: process.execPath, args: ['advanced-demo.js'], cwd: project,
    allowChanges: [{ field: 'source', reason: 'Apply the original demo fix.' }] });
  assert.equal(fixed.status, 'target_not_observed');
  assert.equal(fixed.candidate.healthyTrials, 2);

  // Controlled NUnit reports exercise the real parser. This is not a Unity Editor recording.
  await writeFile(join(project, 'nunit-report.mjs'), `import { readFile, writeFile } from 'node:fs/promises';
const state = (await readFile('test-state.txt', 'utf8')).trim();
const counts = 'total="1" passed="'+Number(state==='Passed')+'" failed="'+Number(state==='Failed')+'" skipped="'+Number(state==='Skipped')+'" inconclusive="0"';
const failure = state === 'Failed' ? '<failure><message>INVENTORY_ITEMS_LOST</message></failure>' : '';
await writeFile(process.env.FAILTRACE_TEST_REPORT, '<test-run result="'+state+'" '+counts+'><test-suite result="'+state+'"><test-case fullname="${fullName}" result="'+state+'">'+failure+'</test-case></test-suite></test-run>');
process.exitCode = state === 'Failed' ? 1 : 0;
`);
  await writeFile(join(project, 'test-state.txt'), 'Failed');
  unitBaseline = await call('failtrace_run', { command: process.execPath, args: ['nunit-report.mjs'], repeat: 1,
    predicate: { kind: 'nunit_test', fullName, messageContains: 'INVENTORY_ITEMS_LOST' },
    captureContext: { sourceFiles: ['nunit-report.mjs', 'test-state.txt'] } });
  assert.equal(unitBaseline.assessment, 'reproduced');
  assert.equal(unitBaseline.trials[0].unitTest.fullName, fullName);
  const verifyUnit = () => call('failtrace_verify', { baseline: unitBaseline.artifactDirectory, command: process.execPath,
    args: ['nunit-report.mjs'], cwd: project, allowChanges: [{ field: 'source', reason: 'Select the controlled NUnit report outcome.' }] });
  await writeFile(join(project, 'test-state.txt'), 'Passed');
  unitFixed = await verifyUnit();
  assert.equal(unitFixed.status, 'target_not_observed');
  assert.equal(unitFixed.candidate.healthyTrials, 1);
  await writeFile(join(project, 'test-state.txt'), 'Skipped');
  unitSkipped = await verifyUnit();
  assert.equal(unitSkipped.status, 'inconclusive');
  const page = await call('failtrace_inspect_run', { view: 'trials', run: unitSkipped.candidate.artifactDirectory, limit: 1 });
  skippedTrial = page.trials[0].unitTest;
  assert.equal(skippedTrial.outcome, 'inconclusive');
  assert.match(skippedTrial.reason, /skipped/i);
} finally {
  await writeFile(join(evidence, 'mcp-transcript.private.json'), JSON.stringify(transcript, null, 2));
  await client.close();
}
assert.deepEqual(diagnostics, []);
const demo = JSON.parse((await invoke(['demo', '--json'])).stdout);
assert.equal(demo.status, 'completed');
assert.deepEqual(demo.reduction.minimizedInput, ['BUG']);
assert.equal(demo.reduction.finalVerified, true);
const bundleFiles = await readdir(demo.bundle.directory);
for (const name of ['repro.mjs', 'manifest.json', 'source']) assert(bundleFiles.includes(name));
assert((await readdir(join(demo.bundle.directory, 'source'))).includes('advanced-demo.js'));
const replay = await execute(process.execPath, [join(demo.bundle.directory, 'repro.mjs')], {
  cwd: evidence, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
}).then(() => { throw new Error('The intentionally failing replay must exit 1.'); }, error => error);
assert.equal(replay.code, 1);
assert.equal(replay.stderr, '');
const replayLine = replay.stdout.split(/\r?\n/).find(line => line.includes('Target failure reproduced:'));
assert.equal(replayLine, 'Target failure reproduced: 1 / 1');
await writeFile(join(evidence, 'demo.private.json'), JSON.stringify(demo, null, 2));
await writeFile(join(evidence, 'replay.private.txt'), replay.stdout);

const heading = value => text(28, 44, value, c.ink, 29, 'font-weight="700"');
const line = (y, value, color = c.ink, size = 20) => text(28, y, value, color, size, mono);
const rule = y => `<path d="M28 ${y}H932" stroke="#2b374b"/>`;
const highlight = (y, color) => `<rect x="16" y="${y - 24}" width="924" height="35" rx="5" fill="${color}" fill-opacity=".1"/>`;
const scenes = [
  { name: 'agent-session.png', title: 'FailTrace — MCP session', cursor: [543, 429],
    body: heading('Give your agent evidence it can inspect.')
      + line(78, `MCP connected · ${listing.tools.length} tools available`, c.muted, 17) + rule(96)
      + line(134, '> failtrace_run', c.blue)
      + line(166, '  predicate: stderr_contains("BUG reproduced")', c.muted)
      + line(198, `  requestedTrials: ${baseline.requestedTrials}   matchedTrials: ${baseline.matchedTrials}`, c.red)
      + line(248, '> failtrace_inspect_run  [saved stderr, trial 1]', c.blue)
      + line(280, `  ${output.text.trim()}`, c.ink)
      + line(330, '> failtrace_verify  [declared source change]', c.blue)
      + highlight(362, c.green) + line(362, `  status: ${fixed.status}`, c.green)
      + line(398, `  matchedTrials: ${fixed.candidate.matchedTrials}   healthyTrials: ${fixed.candidate.healthyTrials}`, c.green)
      + rule(428) + line(462, 'Same failure signature. Saved evidence. Rechecked patch.', c.muted, 18)
      + line(494, 'A healthy sample does not prove that the bug is gone.', c.muted, 16) },
  { name: 'unit-test-evidence.png', title: 'FailTrace — NUnit test evidence', cursor: [425, 477],
    body: heading('Follow the test, including when it is skipped.')
      + line(86, 'predicate: nunit_test', c.blue) + line(116, fullName, c.ink, 20)
      + line(148, 'messageContains: INVENTORY_ITEMS_LOST', c.muted, 18) + rule(170)
      + line(210, 'BASELINE  /  failing report', c.red, 18)
      + line(244, `  assessment: ${unitBaseline.assessment}   matchedTrials: ${unitBaseline.matchedTrials}`, c.red)
      + line(293, 'CANDIDATE /  passing report', c.green, 18)
      + line(327, `  status: ${unitFixed.status}   healthyTrials: ${unitFixed.candidate.healthyTrials}`, c.green)
      + line(376, 'CONTROL   /  skipped report', c.amber, 18)
      + highlight(410, c.amber) + line(410, `  status: ${unitSkipped.status}`, c.amber)
      + rule(440) + line(474, 'A skipped test is not evidence that the selected test passed.', c.muted, 18) },
  { name: 'reproduction-bundle.png', title: 'FailTrace — reproduction bundle', cursor: [546, 438],
    body: heading('Keep a failure you can run again.')
      + line(84, 'Original controlled demo · reduced input verified', c.muted, 17) + rule(103)
      + line(143, `Reduced input: ${JSON.stringify(demo.reduction.minimizedInput)}`, c.blue)
      + line(190, 'reproduction/', c.ink)
      + line(222, '  source/advanced-demo.js  target command', c.muted)
      + line(253, '  manifest.json          file identities', c.muted)
      + line(284, '  repro.mjs              replay entry point', c.muted)
      + line(336, '$ node reproduction/repro.mjs', c.blue)
      + highlight(372, c.red) + line(372, replayLine, c.red)
      + line(406, `exit code: ${replay.code}`, c.amber)
      + rule(438) + line(470, 'Exit 1 is the expected failure in this replay.', c.muted, 18)
      + line(502, 'Include dependencies and setup needed by your own target.', c.muted, 16) },
];
const assets = join(root, 'docs/assets');
await mkdir(assets, { recursive: true });
const sha256 = {};
for (const scene of scenes) {
  const svg = windowFrame(scene);
  // Never allow host identifiers to enter public SVG text or pixels.
  for (const value of [process.env.USERPROFILE, process.env.USERNAME, process.env.COMPUTERNAME].filter(Boolean)) {
    assert(!svg.toLowerCase().includes(value.toLowerCase()), 'Host identifier in public scene');
  }
  await writeFile(join(evidence, scene.name.replace('.png', '.svg')), svg);
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  assert(bytes.length < 250 * 1024, 'Keep individual README screenshots compact.');
  await writeFile(join(assets, scene.name), bytes);
  sha256[scene.name] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(join(assets, 'readme-scenes.json'), JSON.stringify({ version, presentation: 'macos-style-frame-with-pointer',
  sources: ['recorded MCP calls', 'controlled NUnit 3 XML reports', 'recorded CLI bundle replay'],
  outcomes: { tools: listing.tools.length, baselineMatches: baseline.matchedTrials, fixedStatus: fixed.status,
    fixedHealthyTrials: fixed.candidate.healthyTrials, nunitBaseline: unitBaseline.assessment,
    nunitPassed: unitFixed.status, nunitSkipped: unitSkipped.status, replayExit: replay.code }, sha256 }, null, 2) + '\n');
console.log(JSON.stringify({ version, images: scenes.map(scene => scene.name), evidence, verified: true }));

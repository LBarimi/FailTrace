// Maintainer-only GIF renderer. See docs/DEMO.md; no runtime dependency is added.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  assert(['--cli', '--sharp'].includes(flag) && process.argv[i + 1] && !options[flag], 'Usage: node scripts/render-demo-animation.mjs [--cli installed/dist/cli/index.js] [--sharp sharp-package-directory]');
  options[flag] = resolve(process.argv[i + 1]);
}
const require = createRequire(join(root, '.failtrace', 'media-tools', 'package.json'));
const sharp = require(options['--sharp'] ?? 'sharp');
const cli = options['--cli'] ?? join(root, 'dist', 'cli', 'index.js');
const execute = (args) => promisify(execFile)(process.execPath, [cli, ...args], {
  cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
});
const version = (await execute(['--version'])).stdout.trim();
assert(/^\d+\.\d+\.\d+$/.test(version), 'Render a stable, explicitly verified version.');
const demo = JSON.parse((await execute(['demo', '--json'])).stdout);
assert.equal(demo.status, 'completed');
assert.deepEqual(demo.reduction.originalInput, ['login', 'catalog', 'cart', 'BUG', 'receipt', 'logout']);
assert.deepEqual(demo.reduction.minimizedInput, ['BUG']);
assert.equal(demo.reduction.finalVerified, true);
assert.equal(demo.verification.baselineControl.status, 'target_observed');
assert.equal(demo.verification.baselineControl.matchedTrials, 2);
const unrelated = demo.verification.unrelatedCandidate;
const fixed = demo.verification.fixedCandidate;
assert.equal(unrelated.status, 'inconclusive');
assert.equal(unrelated.matchedTrials, 0);
assert.equal(unrelated.unrelatedFailureTrials, 2);
assert.equal(fixed.status, 'target_not_observed');
assert.equal(fixed.healthyTrials, 2);
assert.equal(fixed.matchedTrials, 0);
assert.equal(demo.bundle.evidenceIncluded, false);
assert(demo.bundle.manifestPath && demo.replayCommand);
const run = JSON.parse(await readFile(join(demo.repetition.artifactDirectory, 'run.json'), 'utf8'));
assert.equal(run.trials.length, 10);
assert.equal(run.trials.filter(trial => trial.failureMatched === true).length, 3);
assert(run.trials.every(trial => trial.terminationReason === 'exit' && ['passed', 'failed'].includes(trial.status)));

// Public pixels use only validated demo fixture values, counts and status enums.
// Never render command paths, artifact paths, environment values or raw logs.
const width = 960, height = 520;
const c = { bg: '#09111d', panel: '#101c2d', edge: '#27364b', ink: '#f0f5fb', muted: '#9aadc4', blue: '#88b8ff', green: '#72dfb3', red: '#ff8796', amber: '#ffcc80' };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (x, y, value, size = 20, fill = c.ink, extra = '') => `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" ${extra}>${escape(value)}</text>`;
const rect = (x, y, w, h, fill, radius = 8, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" ${extra}/>`;
const mono = `font-family="'Cascadia Code', 'DejaVu Sans Mono', Consolas, monospace"`;
const headings = ['This test fails. Then it passes.', 'Keep the input that triggers it.', 'The error disappeared. Did the fix work?', 'Check the patch against the baseline.'];
const descriptions = ['Save repeated trials so your agent can inspect the failure.', 'Six items become one. The same failure still reproduces.', 'An unrelated crash makes this candidate inconclusive.', 'Two healthy trials, no target observed. Keep the replay.'];

function scene(stage, step) {
  let body = '';
  if (stage === 0) {
    body += run.trials.map((trial, i) => `<circle cx="${84 + i * 78}" cy="266" r="17" fill="${i < step ? trial.failureMatched ? c.red : c.green : c.edge}"/>`
      + text(84 + i * 78, 307, String(trial.index).padStart(2, '0'), 14, c.muted, 'text-anchor="middle"')).join('');
    const completed = run.trials.slice(0, step);
    const matches = completed.filter(trial => trial.failureMatched).length;
    body += text(64, 354, `${completed.length - matches} passed`, 25, c.green, mono);
    body += text(300, 354, `${matches} target failures`, 25, c.red, mono);
    body += text(64, 396, step === 10 ? 'Trials and logs saved for inspection.' : 'Recording the same failure signature…', 19, c.muted);
  } else if (stage === 1) {
    body += demo.reduction.originalInput.map((value, i) => `<g opacity="${step > 0 && value !== 'BUG' ? '0.22' : '1'}">`
      + rect(64 + i * 137, 241, 122, 46, value === 'BUG' ? '#442837' : '#1b2e47')
      + text(125 + i * 137, 271, value, 19, value === 'BUG' ? c.red : c.ink, `${mono} text-anchor="middle"`) + '</g>').join('');
    body += text(64, 347, step === 2 ? JSON.stringify(demo.reduction.minimizedInput) : 'Removing unrelated input…', step === 2 ? 42 : 23, c.ink, mono);
    if (step === 2) body += text(310, 342, 'failure still reproduced', 22, c.green);
    body += text(64, 396, step === 2 ? 'Separate final check: target observed.' : 'The target must survive each accepted reduction.', 19, c.muted);
  } else if (stage === 2) {
    body += text(64, 260, 'Original failure matches', 21, c.muted) + text(820, 260, unrelated.matchedTrials, 25, c.ink, mono);
    if (step >= 1) body += text(64, 304, 'Unrelated failures', 21, c.muted) + text(820, 304, unrelated.unrelatedFailureTrials, 25, c.amber, mono);
    if (step === 2) body += rect(64, 322, 832, 51, '#392b1c') + text(84, 356, 'RESULT', 14, c.amber)
      + text(215, 357, unrelated.status, 30, c.amber, mono)
      + text(64, 405, 'Inspect the new error before accepting this patch.', 19, c.muted);
  } else {
    body += text(64, 260, 'Healthy trials', 21, c.muted) + text(820, 260, fixed.healthyTrials, 25, c.green, mono);
    body += text(64, 304, 'Target matches', 21, c.muted) + text(820, 304, fixed.matchedTrials, 25, c.ink, mono);
    if (step === 1) body += rect(64, 322, 832, 51, '#142f2b') + text(84, 356, 'RESULT', 14, c.green)
      + text(215, 357, fixed.status, 29, c.green, mono)
      + text(64, 405, 'Bundle ready: source + input + manifest + replay.', 19, c.muted);
  }
  const steps = ['REPEAT', 'MINIMIZE', 'VERIFY', 'RECHECK'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="960" height="520" rx="16" fill="${c.bg}"/>
<g font-family="Arial, 'DejaVu Sans', sans-serif">
${text(40, 48, 'FailTrace', 25, c.ink, 'font-weight="700"')}
${text(182, 47, 'Debugging evidence for coding agents', 17, c.muted)}
${rect(790, 22, 130, 36, '#182b44')}${text(855, 46, 'CLI + MCP', 14, c.blue, 'text-anchor="middle" font-weight="700"')}
${text(40, 106, headings[stage], 33, c.ink, 'font-weight="700"')}
${text(40, 144, descriptions[stage], 20, c.muted)}
${rect(40, 170, 880, 260, c.panel, 12, `stroke="${c.edge}"`)}
${text(64, 204, '$ failtrace demo', 18, c.blue, mono)}
${text(896, 203, `${stage + 1} / 4 · ${steps[stage]}`, 13, c.muted, 'text-anchor="end"')}
<path d="M40 221H920" stroke="${c.edge}"/>
${body}
${text(40, 470, `$ npx --yes failtrace@${version} demo`, 21, c.green, mono)}
${[0, 1, 2, 3].map(i => rect(772 + i * 38, 456, 28, 5, stage === i ? c.blue : c.edge, 2)).join('')}
${text(40, 502, 'Recorded CLI demo · abridged output · edited timing · finite observations', 13, c.muted)}
</g></svg>`;
}

// The first frame carries the problem and its observed result even before playback.
const frames = [{ svg: scene(0, 10), delay: 2200 }];
for (const [stage, delays] of [[1, [700, 900, 1800]], [2, [650, 700, 2400]], [3, [850, 3500]]]) {
  for (let step = 0; step < delays.length; step++) frames.push({ svg: scene(stage, step), delay: delays[step] });
}
const pixels = [];
for (const frame of frames) pixels.push(await sharp(Buffer.from(frame.svg)).removeAlpha().raw().toBuffer());
const assets = join(root, 'docs', 'assets');
await mkdir(assets, { recursive: true });
const gif = await sharp(Buffer.concat(pixels), { raw: { width, height: height * frames.length, channels: 3, pageHeight: height } })
  .gif({ loop: 0, delay: frames.map(frame => frame.delay), colours: 128, dither: 0, effort: 7 }).toBuffer();
assert(gif.length < 1024 * 1024, 'Keep the README GIF below 1 MiB.');
await writeFile(join(assets, 'demo.gif'), gif);
await sharp(Buffer.from(scene(0, 10))).png().toFile(join(assets, 'demo-poster.png'));
const sha256 = {};
for (const name of ['demo.gif', 'demo-poster.png', 'demo.svg']) {
  sha256[name] = createHash('sha256').update(await readFile(join(assets, name))).digest('hex');
}
await writeFile(join(assets, 'demo-recording.json'), JSON.stringify({
  version, scenario: 'original-guided-demo', editedTiming: true,
  outcomes: { trials: 10, targetMatches: 3, reducedInput: demo.reduction.minimizedInput,
    unrelatedCandidate: unrelated.status, fixedCandidate: fixed.status, healthyFixedTrials: fixed.healthyTrials },
  sha256,
}, null, 2) + '\n');
// Inspectable vector storyboards are private render evidence, not package files.
const privateFrames = join(demo.artifactDirectory, 'animation-frames');
await mkdir(privateFrames);
for (let stage = 0; stage < 4; stage++) await writeFile(join(privateFrames, `${stage + 1}.svg`), scene(stage, [10, 2, 2, 1][stage]));
console.log(JSON.stringify({ version, gifBytes: gif.length, durationMs: frames.reduce((sum, frame) => sum + frame.delay, 0), frames: frames.length, evidence: demo.artifactDirectory }));

// Regenerate the README preview from an actual successful demo, not canned results.
// Run after npm run build: node scripts/render-demo.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--cli'),
  'Usage: node scripts/render-demo.mjs [--cli installed/dist/cli/index.js]');
const cli = process.argv[3] ? resolve(process.argv[3]) : join(root, 'dist/cli/index.js');
const { stdout } = await promisify(execFile)(process.execPath, [cli, 'demo', '--json'], {
  cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
});
const demo = JSON.parse(stdout);
assert.equal(demo.status, 'completed');
assert.equal(demo.reduction.finalVerified, true);
assert.equal(demo.verification.baselineControl.status, 'target_observed');
assert.equal(demo.verification.baselineControl.matchedTrials, 2);
assert.equal(demo.verification.unrelatedCandidate.status, 'inconclusive');
assert.equal(demo.verification.unrelatedCandidate.unrelatedFailureTrials, 2);
assert.equal(demo.verification.fixedCandidate.status, 'target_not_observed');
assert.equal(demo.verification.fixedCandidate.healthyTrials, 2);
const stats = demo.repetition.statistics;
const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (x, y, value, color = '#d8e4f3', size = 18) => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}">${escape(value)}</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="568" viewBox="0 0 960 568" role="img" aria-labelledby="title description">
<title id="title">FailTrace: reproduce, minimize, verify, replay</title>
<desc id="description">An original controlled demo recorded ${stats.passed} passing and ${stats.failed} failing trials, reduced ${demo.reduction.originalInput.length} JSON elements to ${escape(JSON.stringify(demo.reduction.minimizedInput))}, rejected an unrelated crash, observed no target in two healthy fixed-candidate trials, and created a replayable bundle.</desc>
<rect width="960" height="568" rx="18" fill="#0c1523"/>
<path d="M18 0H942Q960 0 960 18V52H0V18Q0 0 18 0" fill="#182538"/>
<circle cx="26" cy="26" r="6" fill="#ff6f72"/><circle cx="48" cy="26" r="6" fill="#edc26c"/><circle cx="70" cy="26" r="6" fill="#66d2a0"/>
<g font-family="'Cascadia Code', 'DejaVu Sans Mono', Consolas, monospace" xml:space="preserve">
${text(96, 32, 'FailTrace — local debugging evidence', '#8fa5bf', 14)}
${text(34, 92, '$ failtrace demo', '#f1f6fc', 23)}
${text(34, 141, '01  REPRODUCE', '#81b4ff', 16)}
${text(70, 176, `${stats.passed} healthy trials   ${stats.failed} target failures   logs saved`)}
${text(34, 220, '02  MINIMIZE', '#81b4ff', 16)}
${text(70, 252, `${demo.reduction.originalInput.length} JSON elements  →  ${JSON.stringify(demo.reduction.minimizedInput)}   final failure verified`)}
${text(34, 301, '03  VERIFY A PROPOSED FIX', '#81b4ff', 16)}
${text(70, 333, 'Baseline control      target observed        2 / 2 matches')}
${text(70, 363, 'Unrelated crash       inconclusive           2 unrelated failures')}
${text(70, 393, 'Intended fix          target not observed    2 healthy observations')}
${text(34, 445, '04  SHARE A REPRODUCTION', '#81b4ff', 16)}
${text(70, 480, 'Bundle created: source + input + manifest + replay scripts')}
${text(34, 538, 'Finite observations, not proof of elimination. Full evidence: .failtrace/demos/<id>/', '#8fa5bf', 14)}
</g></svg>\n`;
const destination = join(root, 'docs/assets/demo.svg');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, svg);
console.log(JSON.stringify({ preview: destination, evidence: demo.artifactDirectory, status: demo.status }, null, 2));

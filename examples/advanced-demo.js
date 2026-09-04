import { readFile } from 'node:fs/promises';
import { checkout } from './advanced-demo-implementation.js';

// Minimization and bundles set FAILTRACE_INPUT to each candidate's location.
const input = process.env.FAILTRACE_INPUT ?? new URL('./advanced-input.json', import.meta.url);
const values = JSON.parse(await readFile(input, 'utf8'));
if (!Array.isArray(values)) throw new Error('Demo input must be a JSON array.');
if (checkout(values).duplicateWorkAccepted) {
  console.error('BUG reproduced: checkout received BUG');
  process.exitCode = 1;
} else {
  console.log('Checkout passed.');
}

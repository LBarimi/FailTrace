import { readFile } from 'node:fs/promises';

const selected = process.argv[2] ?? 'affected';
if (!['affected', 'fixed'].includes(selected) || process.argv.length > 4) {
  console.error('Usage: node check.mjs [affected|fixed] [input-path]');
  process.exitCode = 2;
} else {
  try {
    const prettier = await import(selected === 'affected' ? 'prettier-affected' : 'prettier-fixed');
    if (prettier.version !== (selected === 'affected' ? '3.0.3' : '3.2.0')) throw new Error('Unexpected Prettier version');
    const input = process.env.FAILTRACE_INPUT ?? process.argv[3] ?? new URL('./fixture.ts', import.meta.url);
    const source = await readFile(input, 'utf8');
    const options = { parser: 'typescript', endOfLine: 'lf' };
    // Only format the input; never execute candidate JavaScript/TypeScript.
    const first = await prettier.format(source, options);
    const second = await prettier.format(first, options);
    console.log(JSON.stringify({ version: prettier.version, first, second }));
    if (first !== second) {
      console.error('PRETTIER_NOT_IDEMPOTENT');
      process.exitCode = 1;
    } else {
      console.log('Formatting is stable after the first pass.');
    }
  } catch (error) {
    // Invalid reduced syntax or missing dependencies are not this bug.
    // Do not echo candidate source, which could contain the failure marker.
    console.error(error instanceof SyntaxError ? 'CANDIDATE_PARSE_ERROR' : 'CASE_SETUP_ERROR');
    process.exitCode = 2;
  }
}

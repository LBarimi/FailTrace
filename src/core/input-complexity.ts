import { MAX_INPUT_DEPTH, MAX_JSON_TOKENS, MAX_TEXT_UNITS } from './input-budget.js';

/** Count Unicode code points without materializing a character array. */
export function textUnits(text: string): number {
  let units = 0;
  for (const _character of text) {
    if (++units > MAX_TEXT_UNITS) throw new Error('Text input exceeds the 1000000 Unicode code point limit.');
  }
  return units;
}

const whitespace = (character: string): boolean => character === ' ' || character === '\t' || character === '\r' || character === '\n';
const separator = (character: string): boolean => whitespace(character) || '{}[],:"'.includes(character);

/**
 * Bound allocation before JSON.parse: count containers, values and object keys,
 * ignoring structure inside strings. JSON.parse remains the syntax validator.
 */
export function assertJsonComplexity(text: string): void {
  let tokens = 0;
  let depth = 0;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset]!;
    if (whitespace(character) || character === ',' || character === ':') continue;
    if (character === '}' || character === ']') { depth--; continue; }
    if (++tokens > MAX_JSON_TOKENS) throw new Error('JSON input exceeds the 100000 value/container/key limit.');
    if (depth > MAX_INPUT_DEPTH) throw new Error('JSON input exceeds the 64 level depth limit.');
    if (character === '{' || character === '[') { depth++; continue; }
    if (character === '"') {
      while (++offset < text.length) {
        if (text[offset] === '\\') offset++;
        else if (text[offset] === '"') break;
      }
    } else {
      // One primitive token (number, boolean or null). Invalid tokens are still
      // rejected by JSON.parse; no parsed value or token list is retained here.
      while (offset + 1 < text.length && !separator(text[offset + 1]!)) offset++;
    }
  }
}

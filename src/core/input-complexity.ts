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

/** Compare decimal values without converting their significant digits to a number. */
function normalizedNumber(token: string): string | undefined {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return undefined; // JSON.parse remains responsible for invalid syntax.
  const fraction = match[3] ?? '';
  const digits = (match[2]! + fraction).replace(/^0+/, '');
  if (digits.length === 0) return `${match[1]}0`;
  let end = digits.length;
  while (digits[end - 1] === '0') end--;
  const significant = digits.slice(0, end);
  const exponent = Number(match[4] ?? '0') - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(exponent)) return undefined;
  return `${match[1]}${significant}e${exponent}`;
}

function assertNumberRoundTrip(token: string): void {
  const original = normalizedNumber(token);
  if (original === undefined) {
    // Syntactically valid numeric tokens with enormous exponents cannot be
    // normalized through a JavaScript number either.
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return;
  }
  const value = Number(token);
  if (!Number.isFinite(value) || original === undefined || original !== normalizedNumber(JSON.stringify(value))) {
    throw new Error('JSON input contains a number that reduction cannot preserve. Use --format text (Core format: "text") to retain its numeric spelling.');
  }
}

/**
 * Bound allocation before JSON.parse: count containers, values and object keys,
 * ignoring structure inside strings. JSON.parse remains the syntax validator.
 * JSON reduction also checks that reencoding cannot change a numeric value.
 */
export function assertJsonComplexity(text: string, preserveNumbers = false): void {
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
      const start = offset;
      while (offset + 1 < text.length && !separator(text[offset + 1]!)) offset++;
      if (preserveNumbers && (character === '-' || (character >= '0' && character <= '9'))) {
        assertNumberRoundTrip(text.slice(start, offset + 1));
      }
    }
  }
}

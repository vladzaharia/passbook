import type { Json } from '../../types.ts';
import { decodeStrings, parseStrings } from '../strings.ts';

const ESCAPE: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
};
const quote = (s: string) => `"${s.replace(/[\\"\n\t\r]/g, (c) => ESCAPE[c] as string)}"`;

/** A `.strings` file as an object, key to value. Throws `StringsError` on bad input. */
export const readStrings = (bytes: Uint8Array): Record<string, Json> =>
  Object.fromEntries(parseStrings(decodeStrings(bytes)));

/** `"k" = "v";\n`, UTF-8, in the object's key order. */
export function writeStrings(values: Record<string, Json>): Uint8Array {
  const text = Object.entries(values)
    .map(([k, v]) => `${quote(k)} = ${quote(String(v))};\n`)
    .join('');
  return new TextEncoder().encode(text);
}

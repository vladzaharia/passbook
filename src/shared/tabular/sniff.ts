import { parseJsonDocument, parseNdjson } from './json.ts';
import { TABULAR_LIMITS, TabularError } from './limits.ts';

export type TabularFormat = 'csv' | 'xlsx' | 'json' | 'ndjson';

export type Sniffed =
  | { format: 'xlsx' }
  | { format: 'csv'; text: string }
  | { format: 'json'; value: unknown }
  | { format: 'ndjson'; items: unknown[] };

const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((s, i) => b[i] === s);

/**
 * Format from content, never the name. ZIP magic means XLSX (the container is checked when it
 * is read); `[` or `{` that parses whole is JSON, else one object per line is NDJSON; else CSV.
 * Text that starts like JSON but is neither is refused as damaged rather than read as CSV.
 */
export function sniff(bytes: Uint8Array): Sniffed {
  if (bytes.length === 0) throw new TabularError('FILE_EMPTY', 'The file is empty.');
  if (bytes.length > TABULAR_LIMITS.fileBytes)
    throw new TabularError('FILE_TOO_LARGE', 'The file is larger than 5 MB.');
  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0))
    throw new TabularError('FILE_FORMAT_UNSUPPORTED', 'Save the sheet as .xlsx or CSV.');
  if (startsWith(bytes, 0x50, 0x4b, 3, 4) || startsWith(bytes, 0x50, 0x4b, 5, 6))
    return { format: 'xlsx' };
  if (startsWith(bytes, 0xff, 0xfe) || startsWith(bytes, 0xfe, 0xff))
    throw new TabularError('FILE_ENCODING', 'Save the file as UTF-8.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TabularError('FILE_ENCODING', 'Save the file as UTF-8.');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\0'))
    throw new TabularError('FILE_FORMAT_UNSUPPORTED', 'This file type is not supported.');
  if (text.trim() === '') throw new TabularError('FILE_EMPTY', 'The file is empty.');
  const lead = text.trimStart()[0];
  if (lead !== '[' && lead !== '{') return { format: 'csv', text };
  try {
    return { format: 'json', value: parseJsonDocument(text) };
  } catch (error) {
    if (!(error instanceof TabularError) || error.code !== 'FILE_DAMAGED') throw error;
  }
  if (lead === '{') return { format: 'ndjson', items: parseNdjson(text) };
  throw new TabularError('FILE_DAMAGED', 'The JSON is not valid.');
}

import { parseCsvTable } from './csv.ts';
import { jsonTable, ndjsonTable } from './json.ts';
import { TabularError } from './limits.ts';
import { sniff, type TabularFormat } from './sniff.ts';
import { parseXlsx } from './xlsx.ts';

export { TABULAR_LIMITS, TabularError, type TabularErrorCode } from './limits.ts';
export { type Sniffed, sniff, type TabularFormat } from './sniff.ts';

export interface ParsedTable {
  format: TabularFormat;
  columns: string[];
  /** CSV cells are strings; XLSX cells are typed with null for empty; JSON values are as written. */
  records: Record<string, unknown>[];
  /** XLSX: every worksheet name, and the one read. */
  sheets?: string[];
  sheet?: string;
  /** JSON: the pointer records were read from. */
  recordsPointer?: string;
}

export interface ParseOptions {
  /** XLSX: worksheet name; default is the first non-empty visible sheet. */
  sheet?: string;
  /** JSON: RFC 6901 pointer to the records array; default is the detected array. */
  recordsPointer?: string;
}

/**
 * Parses an uploaded file of any supported format. Throws TabularError and nothing else, whatever
 * the input.
 */
export function parseTabular(bytes: Uint8Array, options: ParseOptions = {}): ParsedTable {
  try {
    const s = sniff(bytes);
    switch (s.format) {
      case 'xlsx':
        return { format: 'xlsx', ...parseXlsx(bytes, options) };
      case 'csv':
        return { format: 'csv', ...parseCsvTable(s.text) };
      case 'json':
        return { format: 'json', ...jsonTable(s.value, options.recordsPointer) };
      case 'ndjson':
        return { format: 'ndjson', ...ndjsonTable(s.items) };
    }
  } catch (error) {
    if (error instanceof TabularError) throw error;
    // The original error rides as `cause` so a caller can log its name, never its message.
    throw new TabularError('FILE_DAMAGED', 'The file could not be read.', error);
  }
}

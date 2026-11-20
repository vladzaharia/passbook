import { TAG_IMPORT_MAX_ROWS } from '../../../shared/contracts/nfc-tag-keysets.ts';
import { ValidationError } from '../../platform/errors.ts';
import { normalizeTagId } from './tag-ref.ts';

export type ImportProblemReason = 'bad_uid' | 'bad_key' | 'weak_key' | 'dup_file' | 'exists';

export interface ImportRow {
  line: number;
  /** 7-byte UID, lower-case hex. */
  uid: string;
  /** The tag's own file key, 32 hex digits. Never logged or echoed. */
  key: string;
}
export interface ImportProblem {
  line: number;
  /** The UID when it parsed; a cell that did not is never echoed (columns may be swapped). */
  uid: string | null;
  reason: ImportProblemReason;
}

const UID_NAMES = new Set(['uid', 'id', 'tag', 'tagid', 'tag_id', 'serial', 'serialnumber']);
const KEY_NAMES = new Set([
  'key',
  'filekey',
  'file_key',
  'sdmfilereadkey',
  'sdm_file_read_key',
  'sdmkey',
  'sdm_key',
]);
const KEY = /^[0-9a-f]{32}$/;
const BARE = /^[\s:-]*(?:0x)?[0-9a-f:\s-]*$/i;

function delimiterOf(head: string): string {
  if (head.includes('\t')) return '\t';
  return head.includes(';') && !head.includes(',') ? ';' : ',';
}

function cellsOf(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((c) =>
    c
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim(),
  );
}

/**
 * A supplier's CSV: one tag per line, its UID and its file key, a header line optional (`uid`, `key`; any
 * order when named). Good rows come back with the problems of the rest; the first line of a UID wins.
 * More than `TAG_IMPORT_MAX_ROWS` lines is refused whole.
 */
export function parseImportCsv(text: string): {
  rows: ImportRow[];
  problems: ImportProblem[];
  count: number;
} {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .map((raw, i) => ({ raw, line: i + 1 }))
    .filter((l) => l.raw.trim() !== '');
  const first = lines[0];
  if (!first) throw new ValidationError('The file has no rows.', [], 'IMPORT_EMPTY');
  const delimiter = delimiterOf(first.raw);
  let uidAt = 0;
  let keyAt = 1;
  const head = cellsOf(first.raw, delimiter);
  if (head.some((c) => !BARE.test(c))) {
    const names = head.map((c) => c.toLowerCase().replace(/[\s-]+/g, '_'));
    uidAt = names.findIndex((n) => UID_NAMES.has(n));
    keyAt = names.findIndex((n) => KEY_NAMES.has(n));
    if (uidAt < 0 || keyAt < 0)
      throw new ValidationError('The first line needs uid and key columns.', [], 'IMPORT_HEADER');
    lines.shift();
  }
  if (lines.length > TAG_IMPORT_MAX_ROWS)
    throw new ValidationError(
      `Import up to ${TAG_IMPORT_MAX_ROWS} tags at a time.`,
      [],
      'IMPORT_TOO_MANY',
    );
  const rows: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Set<string>();
  for (const { raw, line } of lines) {
    const cells = cellsOf(raw, delimiter);
    const uid = normalizeTagId(cells[uidAt] ?? '');
    if (uid?.length !== 14) {
      problems.push({ line, uid: null, reason: 'bad_uid' });
      continue;
    }
    const key = (cells[keyAt] ?? '').toLowerCase();
    if (!KEY.test(key)) problems.push({ line, uid, reason: 'bad_key' });
    else if (/^0+$/.test(key)) problems.push({ line, uid, reason: 'weak_key' });
    else if (seen.has(uid)) problems.push({ line, uid, reason: 'dup_file' });
    else {
      seen.add(uid);
      rows.push({ line, uid, key });
    }
  }
  return { rows, problems, count: lines.length };
}

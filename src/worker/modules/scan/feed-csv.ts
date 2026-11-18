import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ScanRecordDto } from '../../../shared/contracts/scanners.ts';
import { SCAN_REASON_COPY } from '../../../shared/copy/scan.ts';

export const EXPORT_COLUMNS = [
  'Time (UTC)',
  'Result',
  'Reason',
  'Action',
  'Pass',
  'Template',
  'Event',
  'Scanner',
  'Staff',
  'API key',
  'Approved by',
  'Method',
  'Amount',
  'Override',
  'Offline',
  'Undone',
];

/** The UTC column stays; a time zone adds the local one after it, with the offset so a repeated hour reads apart. */
export function exportColumns(timeZone?: string): string[] {
  return timeZone ? [EXPORT_COLUMNS[0] ?? '', `Time (${timeZone})`, ...EXPORT_COLUMNS.slice(1)] : EXPORT_COLUMNS;
}

const localFormats = new Map<string, Intl.DateTimeFormat>();
function localTime(at: number, timeZone: string): string {
  let format = localFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'shortOffset',
    });
    localFormats.set(timeZone, format);
  }
  return format.format(at);
}

const RESULT = { ok: 'OK', heads_up: 'Heads up', refused: 'Refused' } as const;

/** A cell a spreadsheet would run as a formula starts with a quote, which it shows as nothing. */
function cell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const csvRow = (cells: readonly (string | number | null)[]): string =>
  `${cells.map(cell).join(',')}\r\n`;

/** The reason's headline from the one copy file; a line with a value to fill shows the code. */
function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  const line = SCAN_REASON_COPY[reason as ScanReason]?.headline;
  return line && !line.includes('{') ? line : reason;
}

/** Export only an already-authorized console projection, never the raw scan row. */
export function exportCells(row: ScanRecordDto, timeZone?: string): (string | number | null)[] {
  const cells = [
    new Date(row.at).toISOString(),
    row.outcome ? RESULT[row.outcome] : null,
    reasonText(row.reason),
    row.actionLabel,
    row.passTitle,
    row.templateName,
    row.eventName,
    row.scannerName,
    row.staffName,
    row.apiKeyId,
    row.approvedBy,
    row.method,
    row.amount,
    row.override ? 'Yes' : null,
    row.offline ? 'Yes' : null,
    row.undoneAt === null ? null : new Date(row.undoneAt).toISOString(),
  ];
  if (timeZone) cells.splice(1, 0, localTime(row.at, timeZone));
  return cells;
}

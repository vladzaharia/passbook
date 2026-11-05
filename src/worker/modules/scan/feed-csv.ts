import type { ScanReason } from '../../../shared/contracts/scan.ts';
import { SCAN_REASON_COPY } from '../../../shared/copy/scan.ts';
import type { ScanLogRow } from './repo-feed.ts';

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
  'Approved by',
  'Method',
  'Amount',
  'Override',
  'Offline',
  'Undone',
];

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

export function exportCells(row: ScanLogRow, label: string | null): (string | number | null)[] {
  return [
    new Date(row.at).toISOString(),
    row.outcome ? RESULT[row.outcome] : null,
    reasonText(row.reason),
    label,
    row.passTitle,
    row.templateName,
    row.eventName,
    row.scannerName,
    row.staffName,
    row.approvedBy,
    row.method,
    row.amount,
    row.override ? 'Yes' : null,
    row.offline ? 'Yes' : null,
    row.undoneAt === null ? null : new Date(row.undoneAt).toISOString(),
  ];
}

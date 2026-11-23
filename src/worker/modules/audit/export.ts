import type { z } from 'zod';
import type { AuditEntrySchema } from '../../../shared/contracts/audit.ts';

type Entry = z.infer<typeof AuditEntrySchema>;
type Page = { items: Entry[]; nextCursor: string | null };

const HEAD = ['Time (UTC)', 'Action', 'Actor', 'Target', 'Organization'];

/** A cell that starts with a formula character would run in a spreadsheet. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One row from the redacted entry the list route returns: never detail, never a raw id the reader may not see. */
function csvRow(e: Entry): string {
  return `${[
    new Date(e.at).toISOString(),
    e.action,
    e.actorLabel ?? e.actorType,
    e.targetLabel ?? e.targetType ?? '',
    e.orgId ?? '',
  ]
    .map(cell)
    .join(',')}\r\n`;
}

const EXPORT_MAX_ROWS = 10_000;
const PAGE = 200;

/**
 * Reads the entries the query matches, a page at a time, up to `max` rows, and returns the CSV. `read` is the
 * same service call the list route makes, so filters, tenant scope and redaction are identical. `admit` runs
 * after the first page, which proves the caller may read the log, so a refused caller never spends budget.
 * Past the cap the file ends with a note line and `truncated` is true: the caller sets a header.
 */
export async function auditCsv(
  read: (cursor: string | undefined, limit: number) => Promise<Page>,
  admit: () => Promise<void>,
  max = EXPORT_MAX_ROWS,
): Promise<{ csv: string; truncated: boolean; rows: number }> {
  let page = await read(undefined, Math.min(PAGE, max + 1));
  await admit();
  const lines: string[] = [`${HEAD.join(',')}\r\n`];
  let rows = 0;
  let truncated = false;
  for (;;) {
    for (const entry of page.items) {
      if (rows >= max) {
        truncated = true;
        break;
      }
      lines.push(csvRow(entry));
      rows++;
    }
    if (truncated || !page.nextCursor) break;
    page = await read(page.nextCursor, PAGE);
  }
  if (truncated)
    lines.push(
      `# truncated at ${String(max).replace(/\B(?=(\d{3})+$)/g, ',')} rows; narrow the dates\r\n`,
    );
  return { csv: lines.join(''), truncated, rows };
}

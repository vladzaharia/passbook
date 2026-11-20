import type { z } from 'zod';
import type { AuditEntrySchema } from '../../../shared/contracts/audit.ts';

type Entry = z.infer<typeof AuditEntrySchema>;
export type Page = { items: Entry[]; nextCursor: string | null };

const HEAD = ['Time (UTC)', 'Action', 'Actor', 'Target', 'Organization'];

/** A cell that starts with a formula character would run in a spreadsheet. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One row from the redacted entry the list route returns: never detail, never a raw id the reader may not see. */
export function csvRow(e: Entry): string {
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

/**
 * Streams every entry the query matches, a page at a time, as CSV. `read` is the same service call the list
 * route makes, so filters, tenant scope and redaction are identical. The first page is read before the stream
 * opens, so a refusal is an ordinary error response, not a half-written file.
 */
export async function auditCsvStream(
  read: (cursor: string | undefined) => Promise<Page>,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  let page = await read(undefined);
  let sentHead = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(encoder.encode(`${HEAD.join(',')}\r\n`));
      }
      controller.enqueue(encoder.encode(page.items.map(csvRow).join('')));
      if (!page.nextCursor) {
        controller.close();
        return;
      }
      page = await read(page.nextCursor);
    },
  });
}

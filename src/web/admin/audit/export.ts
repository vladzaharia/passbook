import { AuditListSchema } from '@/shared/contracts/audit.ts';
import { actionLabel } from '@/web/lib/actions.ts';
import { api } from '@/web/lib/api.ts';
import { saveBlob } from '@/web/lib/save-file.ts';
import type { AuditEntry } from './entry-drawer.tsx';
import { actorRef, targetRef } from './labels.ts';

const PAGE = 200;
/** Five pages: 1,000 entries per export. */
export const EXPORT_MAX = PAGE * 5;

/** A cell that starts with a formula character would run in a spreadsheet. */
const cell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** Time, action, actor and target as the console names them. Detail is left out. */
export function auditCsv(
  rows: readonly AuditEntry[],
  orgName: (id: string | null) => string | undefined,
) {
  const head = ['Time (UTC)', 'Action', 'Action code', 'Actor', 'Target', 'Organization'];
  const lines = rows.map((r) =>
    [
      new Date(r.at).toISOString(),
      actionLabel(r.action),
      r.action,
      actorRef(r).name,
      targetRef(r)?.name ?? '',
      r.orgId ? (orgName(r.orgId) ?? r.orgId) : '',
    ]
      .map(cell)
      .join(','),
  );
  return `${[head.join(','), ...lines].join('\r\n')}\r\n`;
}

/** Pages through the log with the page's own filters, then saves one CSV. */
export async function exportAudit(
  path: string,
  query: Record<string, string | number | undefined>,
  orgName: (id: string | null) => string | undefined,
): Promise<number> {
  const rows: AuditEntry[] = [];
  let cursor: string | undefined;
  while (rows.length < EXPORT_MAX) {
    const page = await api.get(path, AuditListSchema, { query: { ...query, cursor, limit: PAGE } });
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  saveBlob(
    new Blob([auditCsv(rows, orgName)], { type: 'text/csv;charset=utf-8' }),
    'audit-log.csv',
  );
  return rows.length;
}

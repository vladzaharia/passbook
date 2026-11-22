import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { useFailedRows } from './api.ts';

/** Rows that failed while the import ran: the first page. */
export function FailedRows({ imp, orgId }: { imp: PassImportDto; orgId: string }) {
  const total = imp.progress?.failed ?? 0;
  const failed = useFailedRows(imp.id, orgId, total > 0);
  const items = failed.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg-strong">{C.results.failedRows}</h3>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[24rem] text-left text-sm">
          <caption className="sr-only">{C.results.failedRows}</caption>
          <thead className="bg-surface-raised text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.row}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.problem}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((r) => (
              <tr key={r.row}>
                <td className="px-3 py-2 tabular-nums text-fg-strong">{r.row}</td>
                <td className="px-3 py-2">{r.message ?? r.code ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > items.length ? (
        <p className="text-xs text-fg-muted">{C.check.truncated(items.length, total)}</p>
      ) : null}
    </div>
  );
}

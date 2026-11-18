import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Badge } from '../../../ui/index.ts';

/** The first 100 problems, errors first: Row, Column, Problem. */
export function ProblemsTable({ imp }: { imp: PassImportDto }) {
  if (imp.problems.length === 0) return null;
  const total = imp.problemTotals.errors + imp.problemTotals.warnings;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <caption className="sr-only">{C.check.errors}</caption>
          <thead className="bg-surface-raised text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.row}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.column}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.problem}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {imp.problems.map((p) => (
              <tr key={`${p.row}:${p.code}:${p.column ?? ''}`}>
                <td className="px-3 py-2 tabular-nums text-fg-strong">{p.row}</td>
                <td className="px-3 py-2 text-fg-muted">{p.column ?? ''}</td>
                <td className="px-3 py-2">
                  {p.severity === 'warning' ? (
                    <Badge tone="warning" className="mr-2">
                      Warning
                    </Badge>
                  ) : null}
                  {p.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {imp.problemsTruncated ? (
        <p className="text-xs text-fg-muted">{C.check.truncated(imp.problems.length, total)}</p>
      ) : null}
    </div>
  );
}

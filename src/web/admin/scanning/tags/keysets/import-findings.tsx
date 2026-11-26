import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { pluralize } from '@/web/lib/format.ts';
import type { ImportResult } from './api.ts';
import { fill } from './words.ts';

const C = KEYSET_COPY.import;

/** What the dry run found: rows ready, then each row that will be skipped. */
export function Findings({ result, replace }: { result: ImportResult; replace: boolean }) {
  const bad = result.problems.length + result.moreProblems;
  return (
    <div className="grid gap-3" aria-live="polite">
      <p className="text-sm font-medium text-fg-strong">
        {fill(replace ? C.replaceReady : C.ready, {
          ok: result.ok,
          rows: pluralize(result.rows, 'row'),
        })}
      </p>
      {bad > 0 ? (
        <div className="max-h-64 overflow-auto rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Rows that will be skipped</caption>
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">
                  Line
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Tag ID
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Skipped because
                </th>
              </tr>
            </thead>
            <tbody>
              {result.problems.map((p) => (
                <tr key={`${p.line}-${p.reason}`} className="border-t border-border">
                  <td className="px-3 py-2 tabular-nums">{p.line}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.uid ?? '—'}</td>
                  <td className="px-3 py-2">{KEYSET_COPY.problem[p.reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.moreProblems > 0 ? (
            <p className="border-t border-border px-3 py-2 text-sm text-fg-muted">
              and {result.moreProblems} more
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

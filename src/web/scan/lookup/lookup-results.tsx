import { ChevronRight, Search, UserRound } from 'lucide-react';
import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';

export function LookupResults({
  result,
  busy,
  query,
  onPick,
}: {
  result: z.infer<typeof ScanLookupResultSchema> | null;
  busy: boolean;
  query: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="scan-lookup-results" aria-busy={busy}>
      <p className="sr-only" role="status">
        {busy ? 'Searching…' : result ? `${result.items.length} results.` : ''}
      </p>
      {result?.items.map((row) => (
        <button
          className="scan-lookup-row"
          type="button"
          key={row.passId}
          data-lookup-result
          onClick={() => onPick(row.passId)}
        >
          {row.photoUrl ? (
            <img src={row.photoUrl} alt="" className="scan-lookup-avatar" />
          ) : (
            <span className="scan-lookup-avatar">
              <UserRound size={20} aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-fg-strong">{row.title}</span>{' '}
            <span className="block text-sm text-fg-muted">
              {[row.subtitle, row.templateName].filter(Boolean).join(' · ')}
            </span>{' '}
            {row.maskedEmail ? (
              <span className="block text-xs text-fg-muted">{row.maskedEmail}</span>
            ) : null}
          </span>
          {row.status !== 'active' || row.doorState === 'in' ? (
            <span className="scan-lookup-status">
              {row.status !== 'active' ? row.status : 'In'}
            </span>
          ) : null}
          <ChevronRight size={16} aria-hidden />
        </button>
      ))}
      {result && !result.items.length && !busy ? (
        <div className="scan-lookup-empty">
          <Search size={32} aria-hidden />
          <p className="font-semibold">No matches</p>
          <p>Check the spelling, or use the full email.</p>
        </div>
      ) : null}
      {!result && !busy ? (
        <p className="text-sm text-fg-muted">
          {query.includes('@')
            ? 'Use the full email address.'
            : 'Type at least 3 letters to search. Enter a full code or ID to scan.'}
        </p>
      ) : null}
      {result?.more ? (
        <p className="py-3 text-sm text-fg-muted">
          Showing 10 matches. Keep typing to narrow the list.
        </p>
      ) : null}
    </div>
  );
}

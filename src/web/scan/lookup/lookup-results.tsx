import { ChevronRight, Search, UserRound } from 'lucide-react';
import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { SCAN_TRAY_COPY } from '../../../shared/copy/scan-tray.ts';
import { pluralize } from '../../lib/format.ts';

export function LookupResults({
  result,
  busy,
  query,
  onPick,
  tray = false,
}: {
  result: z.infer<typeof ScanLookupResultSchema> | null;
  busy: boolean;
  query: string;
  onPick: (id: string) => void;
  /** In the Enter code tray: no hint under the field, one line when nothing matches. */
  tray?: boolean;
}) {
  return (
    <div className="scan-lookup-results" aria-busy={busy}>
      <p className="sr-only" role="status">
        {busy ? 'Searching…' : result ? `${pluralize(result.items.length, 'result')}.` : ''}
      </p>
      {result?.items.map((row) => {
        const states = [
          row.channelsOff ? 'Off' : null,
          row.status !== 'active' ? row.status : row.doorState === 'in' ? 'In' : null,
        ].filter(Boolean);
        return (
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
            {states.length ? (
              <span className="scan-lookup-status">{states.join(' · ')}</span>
            ) : null}
            <ChevronRight size={16} aria-hidden />
          </button>
        );
      })}
      {tray && result && !result.items.length && !busy ? (
        <p className="scan-code-note">{SCAN_TRAY_COPY.noMatches}</p>
      ) : null}
      {!tray && result && !result.items.length && !busy ? (
        <div className="scan-lookup-empty">
          <Search size={32} aria-hidden />
          <p className="font-semibold">No matches</p>
          <p>Check the spelling, or use the full email.</p>
        </div>
      ) : null}
      {!tray && !result && !busy && query.includes('@') ? (
        <p className="text-sm text-fg-muted">Use the full email address.</p>
      ) : null}
      {result?.more ? (
        <p className="py-3 text-sm text-fg-muted">
          Showing 10 matches. Keep typing to narrow the list.
        </p>
      ) : null}
    </div>
  );
}

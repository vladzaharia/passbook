import type { ReactNode } from 'react';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { formatCount, formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import type { Counts } from '../machine/types.ts';
import { SheetFrame } from './sheet-frame.tsx';
import { Handover, type Summary, Totals } from './shift-parts.tsx';
import './shift-tray.css';

const C = SCAN_HANDHELD_COPY.shift;
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

/** How full the door is: the count with its bar, or Today's count when there is no capacity. */
function Count({ counts }: { counts: Counts | null }) {
  if (!counts) return null;
  const e = counts.event;
  const total = e ? (e.capacity ?? e.expected) : null;
  const n = e ? e.arrived : counts.today;
  const pct = total ? Math.min(100, Math.round((n / total) * 100)) : null;
  return (
    <section className="scan-tray-count" aria-label={C.title} data-testid="shift-count">
      <p>
        <strong>{formatCount(n)}</strong>{' '}
        <span>
          {[total ? fill(C.of, { cap: formatCount(total) }) : null, e ? C.in : C.today]
            .filter(Boolean)
            .join(' ')}
        </span>
      </p>
      {pct !== null ? (
        <div role="img" aria-label={`${pct}%`} className="scan-tray-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * This shift on a handheld (design 6): a 560 tray from the thumb. The count, what you did, the
 * offline queue and the overrides sit above one End shift button; every other total is one tap down.
 */
export function ShiftTray({
  ending,
  since,
  summary,
  timeZone,
  counts,
  pending,
  scope,
  offline,
  error,
  onClose,
  onEnd,
  onEnding,
}: {
  ending: boolean;
  since: number;
  summary: Summary | undefined;
  timeZone: string | null;
  counts: Counts | null;
  pending: number;
  scope: ReactNode;
  offline: ReactNode;
  error: ReactNode;
  onClose: () => void;
  onEnd: () => void;
  onEnding?: () => void;
}) {
  const title = ending ? C.ending : C.title;
  return (
    <SheetFrame
      tray
      label={title}
      onClose={onClose}
      header={
        <div className="scan-tray-head">
          <h2>{title}</h2>
          <p>{fill(C.since, { time: formatTime(since, timeZone ?? undefined) })}</p>
        </div>
      }
      footer={
        ending ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {C.keep}
            </Button>
            <Button disabled={pending > 0} onClick={onEnd}>
              {C.end}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onEnding ?? onEnd}>
            {C.end}
          </Button>
        )
      }
    >
      <Count counts={counts} />
      {scope}
      {summary ? (
        <p className="scan-tray-you" data-testid="shift-you">
          {fill(C.you, { in: summary.ok, refused: summary.refused, undone: summary.undone })}
        </p>
      ) : null}
      {error}
      {offline}
      {summary ? <Handover summary={summary} timeZone={timeZone} /> : null}
      {summary ? (
        <details className="scan-tray-more">
          <summary>{C.all}</summary>
          <div className="flex flex-col gap-5 pt-3">
            <Totals summary={summary} timeZone={timeZone} />
          </div>
        </details>
      ) : null}
      {ending ? (
        <>
          <p className="text-sm">{C.endNote}</p>
          {pending ? <p role="status">{fill(C.pending, { n: pending })}</p> : null}
        </>
      ) : null}
    </SheetFrame>
  );
}

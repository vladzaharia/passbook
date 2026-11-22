import type { ReactNode } from 'react';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import type { Counts } from '../machine/types.ts';
import { SheetFrame } from './sheet-frame.tsx';
import { Handover, type Summary, shiftCount, shiftYou, Totals } from './shift-parts.tsx';
import './shift-tray.css';

const C = SCAN_HANDHELD_COPY.shift;
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

/** How full the door is: the count with its bar, or Today's count when there is no capacity. */
function Count({ counts }: { counts: Counts | null }) {
  const hero = shiftCount(counts);
  if (!hero) return null;
  return (
    <section className="scan-tray-count" aria-label={C.title} data-testid="shift-count">
      <p>
        <strong>{hero.n}</strong> <span>{hero.caption}</span>
      </p>
      {hero.pct !== null ? (
        <div role="img" aria-label={`${hero.pct}%`} className="scan-tray-bar">
          <i style={{ width: `${hero.pct}%` }} />
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
            <Button className="min-h-14 pointer-coarse:min-h-14" onClick={onClose}>
              {C.keep}
            </Button>
            <Button
              variant="danger"
              className="min-h-14 pointer-coarse:min-h-14"
              disabled={pending > 0}
              onClick={onEnd}
            >
              {C.end}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            className="min-h-14 pointer-coarse:min-h-14"
            onClick={onEnding ?? onEnd}
          >
            {C.end}
          </Button>
        )
      }
    >
      <Count counts={counts} />
      {scope}
      {summary ? (
        <p className="scan-tray-you" data-testid="shift-you">
          {shiftYou(summary)}
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
          {pending ? <p role="status">{fill(C.pending, { n: pending })}</p> : null}
          <p className="text-sm">{C.endNote}</p>
        </>
      ) : null}
    </SheetFrame>
  );
}

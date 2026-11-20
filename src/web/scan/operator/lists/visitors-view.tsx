import { LogOut } from 'lucide-react';
import type { Visitor } from '../../../../shared/contracts/visitors.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { VISITOR_COPY } from '../../../../shared/copy/visitors.ts';
import { fill } from '../../ui/copy.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { PersonAvatar } from './person-avatar.tsx';
import { useRoving } from './use-roving.ts';
import './lists.css';
import './views.css';

const V = OPERATOR_COPY.views;
const F = OPERATOR_COPY.floor;

const whenOf = (v: Visitor, timeZone?: string) =>
  v.status === 'in' && v.statusAt
    ? fill(F.inSince, { time: sessionTime(v.statusAt, timeZone) })
    : v.status === 'out' && v.statusAt
      ? `${VISITOR_COPY.status.out} ${sessionTime(v.statusAt, timeZone)}`
      : v.status === 'expected'
        ? fill(F.expected, { time: sessionTime(v.windowFrom, timeZone) })
        : VISITOR_COPY.status[v.status];

/** Today's visitors: who is expected, who is in. A check-in is the ordinary scan of the pass, opened here. */
export function VisitorsView({
  items,
  failed,
  busy,
  online,
  selectedPassId,
  timeZone,
  onOpen,
  onCheckIn,
  onCheckOut,
}: {
  items: readonly Visitor[] | null;
  failed: boolean;
  busy: string | null;
  online: boolean;
  selectedPassId: string | null;
  timeZone?: string | undefined;
  onOpen: (v: Visitor) => void;
  onCheckIn: (v: Visitor) => void;
  onCheckOut: (v: Visitor) => void;
}) {
  const roving = useRoving();
  return (
    <section className="op-list" aria-label={OPERATOR_COPY.tabs.visitors}>
      <div className="op-list-head">
        <span>{V.visitorsHead}</span>
        <span>{items?.length ?? ''}</span>
      </div>
      <div className="op-list-scroll">
        {!online ? (
          <p role="status" className="op-list-note">
            {OPERATOR_COPY.ready.offline}
          </p>
        ) : failed && !items ? (
          <p role="status" className="op-list-note">
            {F.unavailable}
          </p>
        ) : items && !items.length ? (
          <p className="op-list-note">{V.visitorsEmpty}</p>
        ) : null}
        <ul className="op-rows" onKeyDown={roving.onKeyDown}>
          {(items ?? []).map((v, index) => (
            <li
              key={v.id}
              className="op-row"
              data-trail
              data-row-key={`vi-${v.id}`}
              data-selected={selectedPassId === v.passId || undefined}
              data-muted={
                v.status === 'out' ||
                v.status === 'no_show' ||
                v.status === 'cancelled' ||
                undefined
              }
            >
              <button
                type="button"
                className="op-row-main"
                data-roving
                data-testid="op-visitor-row"
                tabIndex={roving.tabIndexOf(index)}
                onFocus={() => roving.onFocusRow(index)}
                onClick={() => onOpen(v)}
              >
                <PersonAvatar name={v.name} tone={v.status === 'in' ? 'ok' : undefined} />
                <span className="op-row-text">
                  <span className="op-row-title" title={v.name}>
                    {v.name}
                  </span>
                  <span className="op-row-meta">
                    {whenOf(v, timeZone)} · {fill(F.host, { name: v.hostName })}
                  </span>
                </span>
              </button>
              {v.status === 'expected' ? (
                <button
                  type="button"
                  className="op-row-btn"
                  data-primary
                  data-roving
                  tabIndex={-1}
                  disabled={!online}
                  onClick={() => onCheckIn(v)}
                >
                  {V.checkIn}
                </button>
              ) : v.status === 'in' ? (
                <button
                  type="button"
                  className="op-row-btn"
                  data-roving
                  tabIndex={-1}
                  disabled={!online || busy === v.id}
                  aria-label={`${V.checkOut}: ${v.name}`}
                  onClick={() => onCheckOut(v)}
                >
                  <LogOut aria-hidden /> {V.checkOut}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

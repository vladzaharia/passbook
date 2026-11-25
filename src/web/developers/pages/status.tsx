import { Check, CircleAlert, CircleMinus, CircleX } from 'lucide-react';
import type { PublicStatus } from '../../../shared/contracts/status.ts';
import { STATUS_COPY } from '../../../shared/copy/developers-ops.ts';
import { BuddyFace } from '../../ui/art/face.tsx';
import '../../ui/art/scenes/face.css';
import { shortDate } from '../model/dates.ts';

/** Placeholder in the prerendered page: the Worker swaps it for the live body (modules/status/public-page.tsx). */
export const STATUS_SLOT = '<div data-status-slot="1"></div>';

const ICON = { operational: Check, degraded: CircleAlert, outage: CircleX, off: CircleMinus };
const PILL = {
  operational: 'success',
  degraded: 'warning',
  outage: 'danger',
  off: 'neutral',
} as const;

/** The page header's face: smiling when all is well, flat when degraded, sad when down. */
const FACE = { operational: 'happy', degraded: 'flat', outage: 'sad', off: 'flat' } as const;

const clock = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

/** The status page body. Same markup at build (no data) and at request time (live), so no script is needed. */
export function StatusBody({ status }: { status: PublicStatus | null }) {
  if (!status) return <p className="muted mt8">{STATUS_COPY.unavailable}</p>;
  return (
    <>
      <div className={`status-banner ${PILL[status.overall]}`} role="status">
        <BuddyFace
          className="status-face"
          size="sm"
          scene={status.overall === 'operational' ? 'cheer' : 'wink'}
          mood={FACE[status.overall]}
        />
        <strong>{STATUS_COPY.overall[status.overall]}</strong>
        <time className="push xs" dateTime={new Date(status.checkedAt).toISOString()}>
          {STATUS_COPY.checked} {clock(status.checkedAt)} UTC
        </time>
      </div>
      <ul className="list card mt6 status-list">
        {status.components.map((c) => {
          const Icon = ICON[c.state];
          return (
            <li key={c.id} className="lrow">
              <span className="strong">{c.label}</span>
              <span className={`pill ${PILL[c.state]} push`}>
                <Icon aria-hidden="true" />
                {STATUS_COPY.state[c.state]}
              </span>
            </li>
          );
        })}
      </ul>
      <h2 className="h2 mt8">{STATUS_COPY.incidents}</h2>
      {status.incidents.length === 0 ? (
        <p className="muted mt4">{STATUS_COPY.noIncidents}</p>
      ) : (
        <ul className="list card mt4 status-list">
          {status.incidents.map((i) => (
            <li key={i.id} className="lrow incident">
              <span className="row g2 wrap-row">
                <span
                  className={`pill ${i.resolvedAt === null ? PILL[i.impact === 'notice' ? 'off' : i.impact] : 'neutral'}`}
                >
                  {i.resolvedAt === null ? STATUS_COPY.open : STATUS_COPY.resolved}
                </span>
                <span className="strong">{i.title}</span>
                <time
                  className="push xs muted nowrap"
                  dateTime={new Date(i.startedAt).toISOString()}
                >
                  {shortDate(new Date(i.startedAt).toISOString().slice(0, 10))}
                </time>
              </span>
              <span className="sm muted">{i.note}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** What the prerendered page holds: the heading and the slot. */
export function StatusView() {
  return (
    <>
      <h1 className="h1 page-h">{STATUS_COPY.title}</h1>
      <div data-status-slot="1" />
    </>
  );
}

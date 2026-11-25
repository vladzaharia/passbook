import { Activity, Monitor, Siren, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { ScanSummarySchema } from '../../../../shared/contracts/scan-session.ts';
import type { SessionDevices } from '../../../../shared/contracts/scanning-session-devices.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { CountUp } from '../../../ui/count-up.tsx';
import type { InsidePlace } from '../../inside/inside-types.ts';
import { fill } from '../../ui/copy.ts';
import { ACCESS_COPY } from '../../ui/copy-access.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { deviceState } from './floor-model.ts';

const F = OPERATOR_COPY.floor;
type Summary = z.infer<typeof ScanSummarySchema>;

export function Card({
  icon,
  title,
  meta,
  children,
  label,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className="op-fl-card" aria-label={label ?? title}>
      <header className="op-fl-head">
        <h3>
          {icon}
          {title}
        </h3>
        {meta ? <span className="op-fl-meta">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function Bar({ value, max, full }: { value: number; max: number | null; full: boolean }) {
  return (
    <span className="op-fl-bar" data-full={full || undefined} aria-hidden>
      <i style={{ inlineSize: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

function PlaceRow({ place, head }: { place: InsidePlace; head: boolean }) {
  const full = place.capacity !== null && place.inNow >= place.capacity;
  return (
    <li className="op-fl-place" data-head={head || undefined} data-full={full || undefined}>
      <span className="op-fl-place-name">
        {head ? null : <i className="op-fl-hook" aria-hidden />}
        {place.name}
        {full && !head ? <em>{` · ${F.full}`}</em> : null}
      </span>
      <b className="op-fl-count">
        <CountUp value={place.inNow} />
        {place.capacity !== null ? <small> / {place.capacity}</small> : null}
      </b>
      {place.capacity !== null ? (
        <Bar value={place.inNow} max={place.capacity} full={full} />
      ) : null}
    </li>
  );
}

/** Who is inside, by place. The scanner's own place leads; the others sit under it. */
export function InNowCard({
  places,
  lead,
  live,
  asOf,
  timeZone,
  onStartRoll,
  rollDisabled,
}: {
  places: readonly InsidePlace[];
  lead: string | null;
  live: boolean;
  asOf: number | null;
  timeZone?: string | undefined;
  onStartRoll?: (() => void) | undefined;
  rollDisabled?: boolean;
}) {
  const head = places.find((p) => p.name === lead) ?? (places.length === 1 ? places[0] : undefined);
  const rest = places.filter((p) => p !== head);
  return (
    <Card
      icon={<Users aria-hidden />}
      title={F.inNow}
      meta={
        live ? (
          <>
            <span className="op-dot" aria-hidden /> {F.live}
          </>
        ) : asOf ? (
          fill(F.asOf, { time: sessionTime(asOf, timeZone) })
        ) : null
      }
    >
      <ul className="op-fl-places">
        {head ? <PlaceRow place={head} head /> : null}
        {rest.map((p) => (
          <PlaceRow key={p.place} place={p} head={false} />
        ))}
      </ul>
      {onStartRoll ? (
        <button type="button" className="op-fl-link" disabled={rollDisabled} onClick={onStartRoll}>
          <Siren aria-hidden /> {ACCESS_COPY.roll.start}
        </button>
      ) : null}
    </Card>
  );
}

export function ShiftCard({
  summary,
  since,
  timeZone,
  failed,
}: {
  summary: Summary | null;
  since: number;
  timeZone?: string | undefined;
  failed: boolean;
}) {
  const cells: [string, number | null][] = [
    [F.checkedIn, summary ? summary.ok : null],
    [F.refused, summary ? summary.refused + summary.headsUp : null],
    [F.undone, summary ? summary.undone : null],
  ];
  return (
    <Card
      icon={<Activity aria-hidden />}
      title={F.shift}
      meta={fill(F.since, { time: sessionTime(since, timeZone) })}
    >
      {failed && !summary ? (
        <p className="op-fl-note" role="status">
          {F.unavailable}
        </p>
      ) : (
        <dl className="op-fl-stats">
          {cells.map(([label, n]) => (
            <div key={label}>
              <dd>{n === null ? '–' : <CountUp value={n} />}</dd>
              <dt>{label}</dt>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

export function DevicesCard({
  items,
  failed,
  now,
}: {
  items: SessionDevices['items'] | null;
  failed: boolean;
  now: number;
}) {
  return (
    <Card
      icon={<Monitor aria-hidden />}
      title={F.devices}
      meta={items ? fill(F.inSession, { n: items.length }) : null}
    >
      {failed && !items ? (
        <p className="op-fl-note" role="status">
          {F.unavailable}
        </p>
      ) : (
        <ul className="op-fl-devices">
          {(items ?? []).map((d) => {
            const state = deviceState(d, now);
            return (
              <li key={d.id}>
                <span className="op-fl-device" title={d.name}>
                  {d.name}
                  {d.self ? <small>{` · ${F.you}`}</small> : null}
                </span>
                <span className="op-fl-state" data-online={state.online || undefined}>
                  <span className="op-dot" data-off={state.online ? undefined : ''} aria-hidden />
                  {state.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

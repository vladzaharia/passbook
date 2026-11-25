import { Clock, LogOut } from 'lucide-react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import { flagged } from '../../inside/inside-model.ts';
import type { InsideRow } from '../../inside/inside-types.ts';
import type { useInside } from '../../inside/use-inside.ts';
import { stayText } from '../../machine/access-view.ts';
import { fill } from '../../ui/copy.ts';
import { ACCESS_COPY } from '../../ui/copy-access.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { ListEmpty } from './list-empty.tsx';
import { PersonAvatar } from './person-avatar.tsx';
import { useRoving } from './use-roving.ts';
import './lists.css';
import './views.css';

const V = OPERATOR_COPY.views;
const FLAG = { long_stay: ACCESS_COPY.inside.longStay, pass_ended: ACCESS_COPY.inside.passEnded };

/** `Gym floor · In since 6:41 PM · 1 h 12 min`, then who let them in. */
const metaOf = (row: InsideRow, now: number, timeZone?: string) =>
  [
    row.type,
    [row.zone.name, row.zone.parent].filter(Boolean).join(', '),
    `In since ${sessionTime(row.since, timeZone)}`,
    stayText(Math.max(0, now - row.since)),
    row.via,
  ]
    .filter(Boolean)
    .join(' · ');

function Row({
  row,
  index,
  now,
  selected,
  stale,
  roving,
  timeZone,
  onOpen,
  onMark,
}: {
  row: InsideRow;
  index: number;
  now: number;
  selected: boolean;
  stale: boolean;
  roving: ReturnType<typeof useRoving>;
  timeZone?: string | undefined;
  onOpen: (row: InsideRow) => void;
  onMark: (row: InsideRow) => void;
}) {
  const name = row.holder ?? ACCESS_COPY.inside.unnamed;
  return (
    <li
      className="op-row"
      data-trail
      data-row-key={`in-${row.passId}-${row.place}`}
      data-selected={selected || undefined}
      data-flag={flagged(row) ? 'hu' : undefined}
    >
      <button
        type="button"
        className="op-row-main"
        data-roving
        data-testid="op-inside-row"
        tabIndex={roving.tabIndexOf(index)}
        aria-current={selected || undefined}
        onFocus={() => roving.onFocusRow(index)}
        onClick={() => onOpen(row)}
      >
        <PersonAvatar name={name} photoUrl={row.photoUrl} />
        <span className="op-row-text">
          <span className="op-row-title" title={name}>
            {name}
          </span>
          <span className="op-row-meta" title={metaOf(row, now, timeZone)}>
            {row.flags.map((flag) => (
              <em key={flag} data-tone="hu">
                {FLAG[flag]}
                {' · '}
              </em>
            ))}
            {row.host ? `${fill(ACCESS_COPY.inside.host, { name: row.host })} · ` : ''}
            {metaOf(row, now, timeZone)}
          </span>
          {row.dueAt ? (
            <span className="op-row-meta op-row-due">
              <Clock aria-hidden />
              {fill(ACCESS_COPY.inside.outBy, { time: sessionTime(row.dueAt, timeZone) })}
            </span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className="op-row-btn"
        data-roving
        tabIndex={-1}
        disabled={stale}
        title={stale ? ACCESS_COPY.inside.needsConnection : undefined}
        aria-label={`${V.markOut}: ${name}`}
        onClick={() => onMark(row)}
      >
        <LogOut aria-hidden /> {V.markOut}
      </button>
    </li>
  );
}

/** Who is inside now, longest first, with the place filter and Mark out. The Who's in list the sheet had, as a view. */
export function InsideView({
  inside,
  online,
  now,
  selectedPassId,
  timeZone,
  onOpen,
  footer,
}: {
  inside: ReturnType<typeof useInside>;
  online: boolean;
  now: number;
  selectedPassId: string | null;
  timeZone?: string | undefined;
  onOpen: (row: InsideRow) => void;
  footer?: React.ReactNode;
}) {
  const roving = useRoving();
  const { state } = inside;
  const stale = !online || state.error;
  const place = state.place;
  return (
    <section
      className="op-list"
      aria-label={OPERATOR_COPY.tabs.inside}
      data-stale={stale || undefined}
    >
      {state.places.length > 1 ? (
        <fieldset className="op-zones" aria-label={V.insideFilter}>
          {[
            { key: null, name: ACCESS_COPY.inside.allPlaces },
            ...state.places.map((p) => ({ key: p.place, name: p.name })),
          ].map((z) => (
            <button
              key={z.key ?? 'all'}
              type="button"
              className="op-zone"
              aria-pressed={place === z.key}
              onClick={() => inside.setPlace(z.key)}
            >
              {z.name}
            </button>
          ))}
        </fieldset>
      ) : null}
      <div className="op-list-head">
        <span>{V.insideHead}</span>
        <span>{state.total}</span>
      </div>
      <div className="op-list-scroll">
        {state.error && !state.rows.length ? (
          <p role="status" className="op-list-note">
            {ACCESS_COPY.inside.failed}
          </p>
        ) : !online && !state.rows.length ? (
          <p role="status" className="op-list-note">
            {ACCESS_COPY.inside.offline}
          </p>
        ) : !state.loading && !state.rows.length ? (
          <ListEmpty>{V.insideEmpty}</ListEmpty>
        ) : null}
        <ul className="op-rows" onKeyDown={roving.onKeyDown}>
          {state.rows.map((row, index) => (
            <Row
              key={`${row.passId}-${row.place}`}
              row={row}
              index={index}
              now={now}
              selected={selectedPassId === row.passId}
              stale={stale}
              roving={roving}
              timeZone={timeZone}
              onOpen={onOpen}
              onMark={(r) => void inside.markOut(r)}
            />
          ))}
        </ul>
        {state.next ? (
          <Button variant="outline" className="op-more" onClick={() => void inside.more()}>
            {ACCESS_COPY.inside.showMore}
          </Button>
        ) : null}
      </div>
      {footer}
    </section>
  );
}

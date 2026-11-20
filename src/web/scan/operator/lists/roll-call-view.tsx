import { Check, CloudOff, Printer, Siren } from 'lucide-react';
import { useState } from 'react';
import type { RollCall, RollCallPerson } from '../../../../shared/contracts/scan-roll-call.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import { ProgressBar } from '../../../ui/progress-bar.tsx';
import { stayText } from '../../machine/access-view.ts';
import type { RollCallState } from '../../roll-call/use-roll-call.ts';
import { fill } from '../../ui/copy.ts';
import { ACCESS_COPY } from '../../ui/copy-access.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { type RollFilter, rollCount, rollRows } from '../floor/floor-model.ts';
import { PersonAvatar } from './person-avatar.tsx';
import { useRoving } from './use-roving.ts';
import './lists.css';
import './views.css';

const R = ACCESS_COPY.roll;
const V = OPERATOR_COPY.views;

function Row({
  p,
  now,
  index,
  total,
  done,
  selected,
  roving,
  timeZone,
  onOpen,
  onMark,
}: {
  p: RollCallPerson;
  now: number;
  index: number;
  total: number;
  done: number;
  selected: boolean;
  roving: ReturnType<typeof useRoving>;
  timeZone?: string | undefined;
  onOpen: (p: RollCallPerson) => void;
  onMark: RollCallState['mark'];
}) {
  const name = p.holder ?? ACCESS_COPY.inside.unnamed;
  const safe = p.mark?.status === 'present';
  const out = p.mark?.status === 'out';
  return (
    <li
      className="op-row"
      data-trail
      data-row-key={`rc-${p.passId}`}
      data-selected={selected || undefined}
      data-lapsed={p.notConfirmedOut || undefined}
      data-testid="roll-call-row"
    >
      <button
        type="button"
        className="op-row-main"
        data-roving
        tabIndex={roving.tabIndexOf(index)}
        onFocus={() => roving.onFocusRow(index)}
        onClick={() => onOpen(p)}
      >
        <PersonAvatar name={name} />
        <span className="op-row-text">
          <span className="op-row-title" title={name}>
            {name}
            {p.plan ? <small className="op-row-tag">{p.plan}</small> : null}
          </span>
          <span className="op-row-meta">
            {p.notConfirmedOut ? <em data-tone="hu">{R.lapsed}</em> : null}
            {p.notConfirmedOut ? ' · ' : ''}
            {[
              p.placeName,
              `In since ${sessionTime(p.since, timeZone)}`,
              stayText(Math.max(0, now - p.since)),
            ].join(' · ')}
            {p.mark?.by ? ` · ${fill(R.by, { name: p.mark.by })}` : ''}
          </span>
        </span>
      </button>
      <span className="op-rc-acts">
        <button
          type="button"
          className="op-rc-btn"
          data-kind="safe"
          data-roving
          tabIndex={-1}
          aria-pressed={safe}
          aria-label={fill(R.safeTitle, { name, n: done + (safe ? 0 : 1), total })}
          onClick={() => onMark(p.passId, safe ? 'none' : 'present')}
        >
          {safe ? <Check aria-hidden /> : null}
          {R.safe}
        </button>
        <button
          type="button"
          className="op-rc-btn"
          data-kind="out"
          data-roving
          tabIndex={-1}
          aria-pressed={out}
          aria-label={fill(R.outTitle, { name })}
          onClick={() => onMark(p.passId, out ? 'none' : 'out')}
        >
          {R.out}
        </button>
      </span>
    </li>
  );
}

/**
 * The roll call takes the list pane while it is open: progress, the four piles, and each person
 * with Safe and Out. The marks and the queue behind them are the sheet's, in `useRollCall`.
 */
export function RollCallView({
  roll,
  call,
  online,
  now,
  selectedPassId,
  timeZone,
  onOpen,
  onPrint,
  onEnd,
}: {
  roll: RollCallState;
  call: RollCall;
  online: boolean;
  now: number;
  selectedPassId: string | null;
  timeZone?: string | undefined;
  onOpen: (p: RollCallPerson) => void;
  /** Print and End live here when there is no floor beside the list. */
  onPrint?: (() => void) | undefined;
  onEnd?: (() => void) | undefined;
}) {
  const roving = useRoving();
  const [filter, setFilter] = useState<RollFilter>('open');
  const c = call.counts;
  const confirmed = c.present + c.out;
  const stale = !online || roll.error;
  const rows = rollRows(call, filter);
  const piles: { value: RollFilter; label: string; n: number }[] = [
    { value: 'open', label: V.toConfirmPile, n: c.unconfirmed },
    ...(c.notConfirmedOut > 0
      ? [{ value: 'lapsed' as const, label: V.lapsedPile, n: c.notConfirmedOut }]
      : []),
    { value: 'present', label: V.safe, n: rollCount(call, 'present') },
    { value: 'out', label: V.out, n: rollCount(call, 'out') },
  ];
  const finished = c.total > 0 && c.unconfirmed === 0;
  return (
    <section className="op-list op-rc" aria-label={V.rollTitle} data-done={finished || undefined}>
      <header className="op-rc-head">
        <h2>
          <Siren aria-hidden /> {V.rollTitle}
          {roll.blocked || roll.pending > 0 || !online ? (
            <span className="op-rc-sync" role="status">
              <CloudOff aria-hidden />{' '}
              {roll.blocked ? R.blocked : fill(R.offline, { n: roll.pending })}
            </span>
          ) : null}
        </h2>
        <p>
          {fill(V.startedAt, { time: sessionTime(call.startedAt, timeZone), name: call.startedBy })}
          {call.placeNames.length ? ` · ${call.placeNames.join(', ')}` : ''}
        </p>
        <ProgressBar
          label={V.rollTitle}
          value={confirmed}
          max={Math.max(1, c.total)}
          valueText={fill(V.confirmedOf, { n: confirmed, total: c.total })}
          tone={finished ? 'success' : 'danger'}
        />
        <p className="op-rc-line" aria-live="polite">
          <span>
            <b>{confirmed}</b> of {c.total} confirmed
          </span>
          <span>{finished ? R.done : fill(V.toConfirm, { n: c.unconfirmed })}</span>
        </p>
      </header>
      <fieldset className="op-zones" aria-label={V.rollPiles}>
        {piles.map((pile) => (
          <button
            key={pile.value}
            type="button"
            className="op-zone"
            aria-pressed={filter === pile.value}
            onClick={() => setFilter(pile.value)}
          >
            {pile.label} <b>{pile.n}</b>
          </button>
        ))}
      </fieldset>
      <div className="op-list-scroll" data-stale={stale || undefined}>
        {!rows.length ? <p className="op-list-note">{R.empty}</p> : null}
        <ul className="op-rows" onKeyDown={roving.onKeyDown} data-testid="roll-call-list">
          {rows.map((p, index) => (
            <Row
              key={p.passId}
              p={p}
              now={now}
              index={index}
              total={c.total}
              done={confirmed}
              selected={selectedPassId === p.passId}
              roving={roving}
              timeZone={timeZone}
              onOpen={onOpen}
              onMark={roll.mark}
            />
          ))}
        </ul>
      </div>
      {onPrint && onEnd ? (
        <footer className="op-rc-foot">
          <Button variant="outline" iconStart={<Printer aria-hidden />} onClick={onPrint}>
            {V.print}
          </Button>
          <Button variant={finished ? 'primary' : 'danger'} disabled={roll.busy} onClick={onEnd}>
            {R.end}
          </Button>
        </footer>
      ) : null}
    </section>
  );
}

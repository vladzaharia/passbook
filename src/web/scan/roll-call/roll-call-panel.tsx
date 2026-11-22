import { Check, CloudOff, LogOut, Printer, Siren } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import type { RollCallPerson } from '../../../shared/contracts/scan-roll-call.ts';
import { cn } from '../../lib/cn.ts';
import { formatTime } from '../../lib/format.ts';
import { EntityAvatar } from '../../ui/avatar.tsx';
import { Button } from '../../ui/button.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { ProgressBar } from '../../ui/progress-bar.tsx';
import { stayText } from '../machine/access-view.ts';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { allConfirmed, filterPeople, type RollFilter } from './roll-call-model.ts';
import type { RollCallState } from './use-roll-call.ts';
import './roll-call.css';

const COPY = ACCESS_COPY.roll;

function Row({
  p,
  now,
  index,
  total,
  done,
  onMark,
}: {
  p: RollCallPerson;
  now: number;
  index: number;
  total: number;
  done: number;
  onMark: RollCallState['mark'];
}) {
  const name = p.holder ?? ACCESS_COPY.inside.unnamed;
  const safe = p.mark?.status === 'present';
  const out = p.mark?.status === 'out';
  return (
    <li
      className="scan-rc-row"
      data-row-id={p.passId}
      data-lapsed={p.notConfirmedOut || undefined}
      data-testid="roll-call-row"
      style={{ '--i': index } as CSSProperties}
    >
      <EntityAvatar kind="user" id={p.passId} name={name} size={40} />
      <div className="scan-rc-main">
        <span className="scan-rc-name">
          <span className="scan-rc-who" dir="auto">
            {name}
          </span>
          {p.plan ? <span className="scan-in-plan">{p.plan}</span> : null}
          {p.late ? <span className="scan-in-flag">{COPY.late}</span> : null}
          {p.notConfirmedOut ? <span className="scan-in-flag">{COPY.lapsed}</span> : null}
        </span>
        <span className="scan-in-meta">
          {[p.placeName, stayText(Math.max(0, now - p.since))].filter(Boolean).join(' · ')}
          {p.mark?.by ? (
            <span className="scan-rc-by"> · {fill(COPY.by, { name: p.mark.by })}</span>
          ) : null}
        </span>
      </div>
      <div className="scan-rc-acts">
        <Button
          variant="ghost"
          size="sm"
          className="scan-rc-out"
          aria-pressed={out}
          aria-label={fill(COPY.outTitle, { name })}
          iconStart={<LogOut aria-hidden />}
          onClick={() => onMark(p.passId, out ? 'none' : 'out')}
        >
          {COPY.out}
        </Button>
        <button
          type="button"
          className="scan-rc-safe"
          aria-pressed={safe}
          aria-label={fill(COPY.safeTitle, { name, n: done + (safe ? 0 : 1), total })}
          onClick={() => onMark(p.passId, safe ? 'none' : 'present')}
        >
          {safe ? <Check aria-hidden size={20} /> : COPY.safe}
        </button>
      </div>
    </li>
  );
}

/**
 * The running roll call: a progress bar, filters, and each person with Safe and Out. Not confirmed
 * people sort first; a stay the clock closed shows Not confirmed out until someone confirms it.
 */
export function RollCallPanel({
  roll,
  online,
  now,
  onEnd,
  onPrint,
}: {
  roll: RollCallState;
  online: boolean;
  now: number;
  onEnd: () => void;
  onPrint: () => void;
}) {
  const call = roll.call;
  const [filter, setFilter] = useState<RollFilter>('all');
  if (!call) return null;
  const c = call.counts;
  const confirmed = c.present + c.out;
  const people = filterPeople(call.people, filter);
  const stale = !online || roll.error;
  const options: { value: RollFilter; label: string }[] = [
    { value: 'all', label: fill(COPY.filters.all, { n: c.total }) },
    { value: 'open', label: fill(COPY.filters.open, { n: c.unconfirmed }) },
    { value: 'done', label: fill(COPY.filters.done, { n: confirmed }) },
    ...(c.notConfirmedOut > 0
      ? [{ value: 'lapsed' as const, label: fill(COPY.filters.lapsed, { n: c.notConfirmedOut }) }]
      : []),
  ];
  const finished = allConfirmed(call);
  return (
    <div className="scan-rc" data-testid="roll-call" data-done={finished || undefined}>
      <header className="scan-rc-head">
        <div className="scan-rc-top">
          <Siren aria-hidden size={18} />
          <h2>{call.placeNames.join(', ') || COPY.title}</h2>
          {roll.blocked ? (
            <span className="scan-chip" data-tone="slate" role="status">
              <CloudOff aria-hidden size={14} />
              {COPY.blocked}
            </span>
          ) : roll.stalled ? (
            <div className="scan-rc-stall">
              <span className="scan-chip" data-tone="slate" role="status">
                <CloudOff aria-hidden size={14} />
                {fill(COPY.stalled, { n: roll.pending })}
              </span>
              <Button variant="outline" size="sm" onClick={roll.retryStalled}>
                {COPY.retry}
              </Button>
            </div>
          ) : roll.pending > 0 || !online ? (
            <span className="scan-chip" data-tone="slate" role="status">
              <CloudOff aria-hidden size={14} />
              {fill(COPY.offline, { n: roll.pending })}
            </span>
          ) : (
            <span className="scan-chip" data-tone="slate">
              {fill(COPY.snapshot, { time: formatTime(call.startedAt) })}
            </span>
          )}
        </div>
        <p className="scan-rc-line" aria-live="polite">
          <strong>
            {finished ? COPY.done : fill(COPY.progress, { n: confirmed, total: c.total })}
          </strong>
          <span>
            {finished
              ? fill(COPY.doneLine, {
                  n: confirmed,
                  total: c.total,
                  min: Math.max(1, Math.round((now - call.startedAt) / 60_000)),
                })
              : stayText(Math.max(0, now - call.startedAt))}
          </span>
        </p>
        <ProgressBar
          label={COPY.title}
          value={confirmed}
          max={Math.max(1, c.total)}
          valueText={fill(COPY.progress, { n: confirmed, total: c.total })}
          tone={finished ? 'success' : 'danger'}
        />
        <p className="scan-rc-basis">
          {[
            c.inNow > 0 ? fill(COPY.inNow, { n: c.inNow }) : null,
            c.tappedIn > 0 ? fill(COPY.tappedIn, { n: c.tappedIn }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>
      <fieldset className="scan-rc-filters" aria-label={COPY.title}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="scan-rc-filter"
            aria-pressed={filter === o.value}
            onClick={() => setFilter(o.value)}
          >
            {o.label}
          </button>
        ))}
      </fieldset>
      <div className={cn('scan-rc-body', stale && 'scan-rc-stale')} data-stale={stale || undefined}>
        {people.length === 0 ? (
          <EmptyState inline art="people" title={COPY.empty} />
        ) : (
          <ol className="scan-in-list" data-testid="roll-call-list">
            {people.map((p, i) => (
              <Row
                key={p.passId}
                p={p}
                now={now}
                index={i}
                total={c.total}
                done={confirmed}
                onMark={roll.mark}
              />
            ))}
          </ol>
        )}
      </div>
      <footer className="scan-rc-foot">
        <Button variant="outline" iconStart={<Printer aria-hidden />} onClick={onPrint}>
          {COPY.print}
        </Button>
        <Button variant={finished ? 'primary' : 'outline'} disabled={roll.busy} onClick={onEnd}>
          {COPY.end}
        </Button>
      </footer>
    </div>
  );
}

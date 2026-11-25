import { Undo2 } from 'lucide-react';
import { reasonHeadline } from '../../../../shared/copy/scan-headline.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { formatAgo } from '../../../lib/format.ts';
import { Buddy } from '../../../ui/art/buddy.tsx';
import { Button } from '../../../ui/button.tsx';
import { CountUp } from '../../../ui/count-up.tsx';
import { sessionTime } from '../../ui/session-time.ts';
import { keyLabel, type ShortcutRow } from '../keys.ts';
import { type ActivityItem, nameOf, toneOf, verdictOf, viewOf } from '../lists/activity-model.ts';
import { PersonAvatar } from '../lists/person-avatar.tsx';
import { Kbd } from './command-field.tsx';
import type { InNow, SessionChip } from './session-state.ts';

const I = OPERATOR_COPY.idle;

export interface IdleFacts {
  items: readonly ActivityItem[];
  today: number;
  inNow: InNow | null;
  needYou: number;
  chip: SessionChip;
  now: number;
  timeZone?: string | undefined;
}

function Mini({ item, timeZone }: { item: ActivityItem; timeZone?: string | undefined }) {
  const row = viewOf(item);
  return (
    <div className="op-mini">
      <PersonAvatar name={row.name} tone={row.tone} unknown={row.unknown} />
      <span className="op-row-text">
        <span className="op-row-title">{row.name}</span>
        <span className="op-row-meta">
          <em data-tone={row.tone}>{row.verdict}</em> · {sessionTime(row.at, timeZone)}
        </span>
      </span>
    </div>
  );
}

/** The record pane with nothing open: the last check-in, the day's numbers, the keys. */
export function IdleView({
  facts,
  keys,
  onOpen,
  onUndo,
  onProblems,
}: {
  facts: IdleFacts;
  keys: readonly ShortcutRow[];
  onOpen: (item: ActivityItem) => void;
  onUndo: (scanId: string) => void;
  onProblems: () => void;
}) {
  const { items, now, timeZone } = facts;
  const last = items.find((item) => item.outcome === 'ok') ?? items[0];
  const rest = items.filter((item) => item !== last).slice(0, 3);
  const tone = last ? toneOf(last) : 'ok';
  const closed = !facts.chip.open;
  return (
    <div className="op-idle">
      {closed ? (
        <p className="op-closed" role="status">
          <b>{I.closed}</b>
          {facts.chip.sub ? ` · ${facts.chip.sub}` : ''}
        </p>
      ) : null}
      <section className="op-last" aria-label={OPERATOR_COPY.landmark.record}>
        {last ? (
          <>
            <Buddy scene="scan" size="lg" mood="happy" pose="rest" />
            <div className="op-last-main">
              <PersonAvatar
                name={nameOf(last)}
                tone={tone}
                unknown={last.title === null}
                size="lg"
              />
              <div className="op-last-text">
                <p className="op-eyebrow">{I.last.replace('{ago}', formatAgo(last.at, now))}</p>
                <h2 className="op-last-name" data-operator-heading tabIndex={-1}>
                  {nameOf(last)}
                </h2>
                <p className="op-last-verdict" data-tone={tone}>
                  <b>{verdictOf(last)}</b>
                  <span>
                    {sessionTime(last.at, timeZone)} · {last.deviceName}
                    {last.outcome !== 'ok' && last.reason
                      ? ` · ${reasonHeadline(last.reason)}`
                      : ''}
                  </span>
                </p>
              </div>
              <div className="op-last-actions">
                {last.passId ? (
                  <Button variant="outline" onClick={() => onOpen(last)}>
                    {I.open}
                  </Button>
                ) : null}
                {last.undoable && last.scanId ? (
                  <Button
                    variant="ghost"
                    iconStart={<Undo2 aria-hidden />}
                    onClick={() => last.scanId && onUndo(last.scanId)}
                  >
                    {I.undo}
                  </Button>
                ) : null}
              </div>
            </div>
            {rest.length ? (
              <div className="op-prev">
                {rest.map((item) => (
                  <Mini key={item.id} item={item} timeZone={timeZone} />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="op-last-empty">
            <h2 data-operator-heading tabIndex={-1}>
              {I.none}
            </h2>
          </div>
        )}
      </section>
      <div className="op-tiles">
        <div className="op-tile">
          <p className="op-tile-k">{I.visits}</p>
          <p className="op-tile-v">
            <CountUp value={facts.today} />
          </p>
        </div>
        {facts.inNow ? (
          <div className="op-tile">
            <p className="op-tile-k">{I.inNow}</p>
            <p className="op-tile-v">
              <CountUp value={facts.inNow.count} />
              {facts.inNow.capacity !== null ? <small> / {facts.inNow.capacity}</small> : null}
            </p>
          </div>
        ) : null}
        <button
          type="button"
          className="op-tile"
          data-tone={facts.needYou ? 'alert' : undefined}
          onClick={onProblems}
        >
          <span className="op-tile-k">{OPERATOR_COPY.tabs.problems}</span>
          <span className="op-tile-v">{facts.needYou}</span>
          <span className="op-tile-s">
            {facts.needYou
              ? I.needYou.replace('{n}', String(facts.needYou))
              : OPERATOR_COPY.problems.empty}
          </span>
        </button>
      </div>
      <p className="op-keys">
        {keys.map((row) => (
          <span key={row.id}>
            {row.keys.map((key) => (
              <Kbd key={key}>{keyLabel(key)}</Kbd>
            ))}{' '}
            {row.label}
          </span>
        ))}
      </p>
    </div>
  );
}

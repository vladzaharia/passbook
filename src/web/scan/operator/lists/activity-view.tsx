import { Activity as ActivityIcon, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { type ActivityItem, viewOf, visibleRows } from './activity-model.ts';
import { PersonAvatar } from './person-avatar.tsx';
import { useRoving } from './use-roving.ts';
import './lists.css';

const C = OPERATOR_COPY.activity;

export function ActivityRow({
  item,
  index,
  selected,
  roving,
  onOpen,
  onUndo,
  timeZone,
}: {
  item: ActivityItem;
  index: number;
  selected: boolean;
  roving: ReturnType<typeof useRoving>;
  onOpen: (item: ActivityItem) => void;
  onUndo: (scanId: string) => void;
  timeZone?: string | undefined;
}) {
  const row = viewOf(item);
  const openable = row.passId !== null;
  const detail = [row.where, row.manual ? C.manual : null].filter(Boolean).join(' · ');
  return (
    <li
      className="op-row"
      data-row-key={row.id}
      data-selected={selected || undefined}
      data-tone={row.tone}
    >
      <button
        type="button"
        className="op-row-main"
        data-roving
        data-testid="op-activity-row"
        tabIndex={roving.tabIndexOf(index)}
        aria-current={selected || undefined}
        aria-disabled={!openable || undefined}
        onFocus={() => roving.onFocusRow(index)}
        onClick={() => openable && onOpen(item)}
      >
        <PersonAvatar name={row.name} tone={row.tone} unknown={row.unknown} />
        <span className="op-row-text">
          <span className="op-row-title" title={row.name}>
            {row.name}
          </span>
          <span className="op-row-meta">
            <em data-tone={row.tone} className={row.tone === 'undone' ? 'op-struck' : undefined}>
              {row.verdict}
            </em>
            {detail ? ` · ${detail}` : ''}
          </span>
        </span>
        <time className="op-row-time" dateTime={new Date(row.at).toISOString()}>
          {sessionTime(row.at, timeZone)}
        </time>
      </button>
      {row.undoable && row.scanId ? (
        <button
          type="button"
          className="op-row-undo"
          data-roving
          tabIndex={-1}
          aria-label={`${C.undo}: ${row.name}`}
          onClick={(event) => {
            // The button leaves with the refresh: the row keeps the focus.
            event.currentTarget.closest('li')?.querySelector<HTMLElement>('.op-row-main')?.focus();
            if (row.scanId) onUndo(row.scanId);
          }}
        >
          <Undo2 aria-hidden /> {C.undo}
        </button>
      ) : null}
    </li>
  );
}

/** Every device in the session, newest first. A list being read does not move under the reader. */
export function ActivityView({
  items,
  loaded,
  unavailable,
  selectedPassId,
  timeZone,
  onOpen,
  onUndo,
}: {
  items: readonly ActivityItem[];
  loaded: boolean;
  unavailable: boolean;
  selectedPassId: string | null;
  timeZone?: string | undefined;
  onOpen: (item: ActivityItem) => void;
  onUndo: (scanId: string) => void;
}) {
  const roving = useRoving();
  const scroller = useRef<HTMLDivElement>(null);
  const shown = useRef(new Set<string>());
  const [holding, setHolding] = useState(false);
  const [flush, setFlush] = useState(0);
  const { rows, queued } = visibleRows(items, shown.current, holding);
  // `flush` is a dependency on purpose: the pill resets what counts as already shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    for (const row of rows) shown.current.add(row.id);
  }, [rows, flush]);
  const release = () => {
    shown.current = new Set();
    setHolding(false);
    setFlush((n) => n + 1);
    scroller.current?.scrollTo({ top: 0 });
  };
  const read = () => {
    const el = scroller.current;
    const inside = Boolean(el?.contains(document.activeElement));
    setHolding(inside || (el?.scrollTop ?? 0) > 8);
  };
  return (
    <section className="op-list" aria-label={OPERATOR_COPY.tabs.activity}>
      <div className="op-list-head">
        <span>{C.heading}</span>
        <ActivityIcon aria-hidden />
      </div>
      {queued > 0 ? (
        <button type="button" className="op-new-pill" onClick={release}>
          {C.newRows.replace('{n}', String(queued))}
        </button>
      ) : null}
      <div
        ref={scroller}
        className="op-list-scroll"
        onScroll={read}
        onFocusCapture={read}
        onBlurCapture={() => setTimeout(read, 0)}
      >
        {unavailable ? (
          <p role="status" className="op-list-note">
            {C.unavailable}
          </p>
        ) : null}
        {!rows.length && loaded && !unavailable ? <p className="op-list-note">{C.empty}</p> : null}
        <ul className="op-rows" onKeyDown={roving.onKeyDown}>
          {rows.map((item, index) => (
            <ActivityRow
              key={item.id}
              item={item}
              index={index}
              roving={roving}
              selected={selectedPassId !== null && item.passId === selectedPassId}
              onOpen={onOpen}
              onUndo={onUndo}
              timeZone={timeZone}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

import { CloudOff, Search } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { ScanTextField } from '../input/wedge-field.tsx';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { sessionTime } from '../ui/session-time.ts';
import { InsidePlaces } from './inside-places.tsx';
import { InsideRowView, MarkOutButton } from './inside-row.tsx';
import { INSIDE_Q_MAX, type InsideRow } from './inside-types.ts';
import type { useInside } from './use-inside.ts';
import './inside.css';

export type Inside = ReturnType<typeof useInside>;

/** A clock that ticks every 30 s, so the stays on the rows stay true. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Who's in: the places and their counts, the search, the list longest first. The desk sheet, the
 * monitor and roll call share it. `trailing` is the row's action (Mark as out by default; a monitor
 * without Desk actions passes none), `header` a banner above, `footer` a strip below.
 */
export function InsidePanel({
  active,
  inside,
  online,
  onOpenRow,
  trailing,
  header,
  footer,
}: {
  active: boolean;
  inside: Inside;
  online: boolean;
  onOpenRow: (row: InsideRow) => void;
  trailing?: (row: InsideRow) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const { state } = inside;
  const now = useNow(active);
  const total = state.places.reduce((n, p) => n + p.inNow, 0);
  const searching = state.q.trim().length > 0;
  const stale = !online || state.error;
  return (
    <div className="scan-in" data-testid="inside-sheet" data-stale={stale || undefined}>
      {header}
      <InsidePlaces
        places={state.places}
        total={total}
        value={state.place}
        onPick={inside.setPlace}
      />
      {searching || state.rows.length > 0 ? (
        <div className="scan-in-search">
          <Search aria-hidden size={18} />
          <ScanTextField
            type="search"
            aria-label={ACCESS_COPY.inside.search}
            placeholder={ACCESS_COPY.inside.search}
            value={state.q}
            onChange={(e) => inside.setQuery(e.target.value)}
            onValueRestore={inside.setQuery}
            autoComplete="off"
            spellCheck={false}
            maxLength={INSIDE_Q_MAX}
            data-scan-code
          />
        </div>
      ) : null}
      {stale && state.asOf !== null ? (
        <p className="scan-chip scan-in-asof" data-tone="slate" role="status">
          <CloudOff aria-hidden size={14} />
          {fill(ACCESS_COPY.inside.asOf, { time: sessionTime(state.asOf) })}
        </p>
      ) : null}
      <div className="scan-in-body" aria-busy={state.loading}>
        {!online && state.rows.length === 0 ? (
          <EmptyState
            inline
            art="plugs"
            title={ACCESS_COPY.inside.offline}
            action={
              <Button onClick={() => void inside.retry()}>{SCAN_COPY.actions.tryAgain}</Button>
            }
          />
        ) : state.loading && state.rows.length === 0 && !state.error ? (
          <SkeletonRows rows={5} />
        ) : state.error && state.rows.length === 0 ? (
          <EmptyState
            inline
            art="plugs"
            title={ACCESS_COPY.inside.failed}
            action={
              <Button onClick={() => void inside.retry()}>{SCAN_COPY.actions.tryAgain}</Button>
            }
          />
        ) : state.rows.length === 0 ? (
          searching ? (
            <EmptyState
              inline
              variant="filtered"
              art="people"
              title={ACCESS_COPY.inside.noMatch}
              action={
                <Button variant="outline" onClick={() => inside.setQuery('')}>
                  {ACCESS_COPY.inside.clear}
                </Button>
              }
            />
          ) : (
            <EmptyState
              inline
              art="wallet"
              artState="empty"
              title={ACCESS_COPY.inside.emptyTitle}
            />
          )
        ) : (
          <ol className="scan-in-list" data-testid="inside-list">
            {state.rows.map((row, index) => (
              <InsideRowView
                key={row.passId}
                row={row}
                index={index}
                now={now}
                onOpen={onOpenRow}
                trailing={
                  trailing ? (
                    trailing(row)
                  ) : (
                    <MarkOutButton
                      row={row}
                      disabled={stale}
                      onMark={(r) => void inside.markOut(r)}
                    />
                  )
                }
              />
            ))}
          </ol>
        )}
        {state.next ? (
          <Button variant="outline" className="scan-in-more" onClick={() => void inside.more()}>
            {ACCESS_COPY.inside.showMore}
          </Button>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

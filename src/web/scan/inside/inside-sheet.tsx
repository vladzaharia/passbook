import { CloudOff, Search } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { ScanTextField } from '../input/wedge-field.tsx';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { InsidePlaces } from './inside-places.tsx';
import { InsideRowView, MarkOutButton } from './inside-row.tsx';
import { INSIDE_Q_MAX, type InsideRow } from './inside-types.ts';
import type { useInside } from './use-inside.ts';
import './inside.css';

type Inside = ReturnType<typeof useInside>;

/** A clock that ticks every 30 s, so the stays on the rows stay true. */
function useNow(active: boolean): number {
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
 * Who's in: the places and their counts, the search, the list longest first. Roll call extends it
 * through `header` (a banner under the title), `trailing` (the row's action, Mark as out by
 * default) and `footer`.
 */
export function InsideSheet({
  open,
  onClose,
  inside,
  online,
  onOpenRow,
  trailing,
  header,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  inside: Inside;
  online: boolean;
  onOpenRow: (row: InsideRow) => void;
  trailing?: (row: InsideRow) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const { state } = inside;
  const now = useNow(open);
  const place = state.places.find((p) => p.place === state.place) ?? state.places[0];
  const total = state.places.reduce((n, p) => n + p.inNow, 0);
  const searching = state.q.trim().length > 0;
  const stale = !online || state.error;
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        title={ACCESS_COPY.inside.title}
        className="scan-inside-sheet"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="scan-in" data-testid="inside-sheet" data-stale={stale || undefined}>
          {header}
          <InsidePlaces
            places={state.places}
            total={total}
            value={state.place}
            onPick={inside.setPlace}
          />
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
          {stale && state.asOf !== null ? (
            <p className="scan-chip scan-in-asof" data-tone="slate" role="status">
              <CloudOff aria-hidden size={14} />
              {fill(ACCESS_COPY.inside.asOf, { time: formatTime(state.asOf) })}
            </p>
          ) : null}
          <div className="scan-in-body" aria-busy={state.loading}>
            {state.loading && state.rows.length === 0 && !state.error ? (
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
                  description={fill(ACCESS_COPY.inside.empty, { place: place?.name ?? '' })}
                />
              )
            ) : (
              <ol className="scan-in-list" data-testid="inside-list">
                {state.rows.map((row) => (
                  <InsideRowView
                    key={row.passId}
                    row={row}
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
      </SheetContent>
    </Sheet>
  );
}

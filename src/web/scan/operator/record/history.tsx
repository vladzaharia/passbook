import {
  ArrowRightFromLine,
  ArrowRightToLine,
  History as HistoryIcon,
  OctagonX,
  ScanLine,
  ShieldCheck,
  Sparkles,
  StickyNote,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { HistoryFilter } from '../../../../shared/contracts/scan-history.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import { SegmentedControl, type SegmentOption } from '../../../ui/segmented-control.tsx';
import { Skeleton } from '../../../ui/skeleton.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { type Glyph, groupDays } from './history-model.ts';
import { useHistory } from './use-history.ts';
import './history.css';

const H = OPERATOR_COPY.history;

const ICON: Record<Glyph, ReactNode> = {
  in: <ArrowRightToLine aria-hidden />,
  out: <ArrowRightFromLine aria-hidden />,
  refused: <OctagonX aria-hidden />,
  held: <TriangleAlert aria-hidden />,
  'let-in': <ShieldCheck aria-hidden />,
  undone: <Undo2 aria-hidden />,
  value: <Sparkles aria-hidden />,
  note: <StickyNote aria-hidden />,
  scan: <ScanLine aria-hidden />,
};

const EMPTY = { all: H.empty, visits: H.emptyVisits, changes: H.emptyChanges } as const;

/**
 * The person's last 30 days: day groups, newest first, filtered All, Visits or Changes. A Door has
 * visits only. Older lines come by asking, never by scrolling, so nothing moves under the reader.
 */
export function History({
  api,
  passId,
  zone,
  now,
  refresh,
  changes,
}: {
  api: ScanApi;
  passId: string;
  zone: string | undefined;
  now: number;
  /** Changes when something new happened to this person: re-reads in place. */
  refresh: unknown;
  /** This role may see changes and notes. */
  changes: boolean;
}) {
  const h = useHistory(api, passId, refresh);
  const days = groupDays(h.items, zone, now);
  const options: SegmentOption<HistoryFilter>[] = [
    { value: 'all', label: H.all },
    { value: 'visits', label: H.visits },
    ...(changes ? [{ value: 'changes' as const, label: H.changes }] : []),
  ];
  return (
    <section className="op-block op-history" aria-label={H.heading} data-testid="op-history">
      <div className="op-block-h">
        <h3>
          <HistoryIcon aria-hidden /> {H.heading}
        </h3>
        <SegmentedControl
          label={H.filter}
          options={options}
          value={h.filter}
          onValueChange={h.setFilter}
        />
      </div>
      {h.loading ? (
        <div className="op-hist-wait" role="status" aria-label={H.loading}>
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : h.failed && h.items.length === 0 ? (
        <p className="op-hist-fail" role="status">
          {H.failed}{' '}
          <Button variant="link" onClick={h.retry}>
            {H.retry}
          </Button>
        </p>
      ) : days.length === 0 ? (
        <p className="op-hist-empty">{EMPTY[h.filter]}</p>
      ) : (
        days.map((day) => (
          <div className="op-hist-day" key={day.key}>
            <h4>{day.heading}</h4>
            <ol>
              {day.lines.map((line) => (
                <li
                  key={line.id}
                  className="op-hist-row"
                  data-tone={line.tone}
                  data-struck={line.struck || undefined}
                  data-testid="op-history-row"
                >
                  <span className="op-hist-glyph">{ICON[line.glyph]}</span>
                  <span className="op-hist-text">
                    <b>{line.title}</b>
                    {line.sub ? <span>{line.sub}</span> : null}
                  </span>
                  <time>{line.time}</time>
                </li>
              ))}
            </ol>
          </div>
        ))
      )}
      {h.hasMore ? (
        <Button variant="outline" onClick={h.more} aria-disabled={h.paging || undefined}>
          {H.more}
        </Button>
      ) : null}
    </section>
  );
}

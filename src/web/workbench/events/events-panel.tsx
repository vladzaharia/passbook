import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { WEBHOOK_EVENT_TYPES, type WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { BENCH_COPY } from '@/shared/copy/developers-bench.ts';
import { copyWithFeedback } from '../../developers/shell/copy.ts';
import { FilterBar, FilterSelect } from '../bench/filter-select.tsx';
import { shortId } from '../bench/id-chip.tsx';
import { useBenchKeys } from '../bench/keys.ts';
import { BenchList, type BenchRowParts } from '../bench/list.tsx';
import { LiveIndicator, useLiveState } from '../bench/live.tsx';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { BenchSplit } from '../bench/split.tsx';
import { BenchTime } from '../bench/time.tsx';
import { Toolbar } from '../bench/toolbar.tsx';
import { useBenchSelection } from '../bench/use-selection.ts';
import { StageState, ToolFailed } from '../states/states.tsx';
import type { EventsParams } from './use-address.ts';
import { type FeedEvent, useEventFeed } from './use-event-feed.ts';
import { useEventsApi } from './use-events.ts';

const TYPES = WEBHOOK_EVENT_TYPES.filter((t) => t !== 'webhook.test');
// The inspector carries the table, dialogs and sheets: it loads when something is selected.
const EventInspector = lazy(() =>
  import('./event-inspector.tsx').then((m) => ({ default: m.EventInspector })),
);

const idOf = (e: FeedEvent) => e.id;

const rowOf = (e: FeedEvent): BenchRowParts => ({
  lead: <BenchTime at={e.createdAt} />,
  title: e.type,
  meta: e.pass?.externalId ?? (e.pass ? shortId(e.pass.id) : undefined),
});

/** The event feed, newest first, and the selected event beside it. */
export function EventsPanel({
  orgId,
  params,
  endpoints,
  write,
  empty,
  sendAction,
  onEmpty,
}: {
  orgId: string;
  params: EventsParams;
  endpoints: readonly WebhookEndpointDto[];
  write: (next: Record<string, string | null>, mode: 'push' | 'replace') => void;
  /** Nothing has arrived and nothing narrows the list. */
  empty: React.ReactNode;
  /** The head's Send test event: not shown while the empty state offers the one way on. */
  sendAction: React.ReactNode;
  /** Whether the empty state is showing. */
  onEmpty: (empty: boolean) => void;
}) {
  const api = useEventsApi();
  const feed = useEventFeed(api, { type: params.type, request: params.request, pass: params.pass });
  const fetchOne = useCallback((id: string) => api.event(id).catch(() => null), [api]);
  const selection = useBenchSelection({
    items: feed.events,
    idOf,
    fetchOne,
    ready: feed.ready,
  });
  const { selectedId, selected, pinned, step } = selection;
  const live = useLiveState(feed.paused);
  // y copies the selected event's id.
  useBenchKeys({ copyId: () => selected && void copyWithFeedback(selected.id, null) });
  const filters = [params.type, params.request, params.pass].filter(Boolean).length;
  const showingEmpty = feed.ready && !feed.failed && feed.events.length === 0 && filters === 0;
  useEffect(() => {
    onEmpty(showingEmpty);
    return () => onEmpty(false);
  }, [showingEmpty, onEmpty]);
  const set = (key: 'type' | 'request' | 'pass', value: string | null) =>
    write({ [key]: value }, 'replace');
  const clear = () => write({ type: null, request: null, pass: null }, 'replace');

  // Another event is another story: the open delivery or capture belongs to the last one.
  const last = useRef(selectedId);
  useEffect(() => {
    if (last.current !== selectedId && (params.endpoint || params.capture))
      write({ endpoint: null, capture: null }, 'replace');
    last.current = selectedId;
  }, [selectedId, params.endpoint, params.capture, write]);

  const order = [...(pinned ? [pinned] : []), ...feed.events];
  const at = selected ? order.findIndex((e) => e.id === selected.id) : -1;
  const scoped = (key: 'request' | 'pass', label: string) =>
    params[key] ? (
      <FilterSelect
        label={label}
        value={params[key]}
        options={[{ value: params[key] as string, label: shortId(params[key] as string) }]}
        onChange={(v) => set(key, v)}
      />
    ) : null;

  return (
    <>
      <LiveIndicator state={live} onResume={feed.resume} />
      <BenchSlot name="action">{showingEmpty ? null : sendAction}</BenchSlot>
      <BenchSlot name="count">{feed.ready ? `${feed.events.length} events` : null}</BenchSlot>
      <Toolbar label="Filter events">
        <FilterBar active={filters} onClear={clear}>
          <FilterSelect
            label="Type"
            value={params.type}
            options={TYPES.map((t) => ({ value: t, label: t }))}
            onChange={(v) => set('type', v)}
          />
          {scoped('request', 'Request')}
          {scoped('pass', 'Pass')}
        </FilterBar>
      </Toolbar>
      <BenchSplit
        bare
        label="Events"
        open={selection.open}
        onClose={() => selection.setOpen(false)}
        main={
          feed.failed ? (
            <ToolFailed reason={BENCH_COPY.state.failed} onRetry={feed.reload} />
          ) : !feed.ready ? (
            <BenchSkeleton rows={6} />
          ) : (
            <BenchList
              label="Events"
              items={feed.events}
              idOf={idOf}
              selection={selection}
              fresh={feed.fresh}
              empty={
                filters > 0 ? (
                  <StageState
                    scene="search"
                    mood="curious"
                    title={BENCH_COPY.state.noMatch}
                    action={
                      <button type="button" className="btn outline" onClick={clear}>
                        {BENCH_COPY.state.clearFilters}
                      </button>
                    }
                  />
                ) : (
                  empty
                )
              }
              row={rowOf}
              footer={{
                count: `${feed.events.length} event${feed.events.length === 1 ? '' : 's'}`,
              }}
            />
          )
        }
        pane={
          selected ? (
            <Suspense fallback={<BenchSkeleton rows={4} />}>
              <EventInspector
                event={selected}
                orgId={orgId}
                endpoints={endpoints}
                open={{ endpoint: params.endpoint, capture: params.capture }}
                onOpen={(next) =>
                  write(
                    { endpoint: next.endpoint ?? null, capture: next.capture ?? null },
                    'replace',
                  )
                }
                onPrev={at > 0 ? () => step(-1) : undefined}
                onNext={at >= 0 && at < order.length - 1 ? () => step(1) : undefined}
              />
            </Suspense>
          ) : null
        }
      />
    </>
  );
}

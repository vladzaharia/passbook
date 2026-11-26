import { lazy, Suspense, useCallback, useEffect } from 'react';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { BenchList, type BenchRowParts } from '../bench/list.tsx';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { BENCH_WIDE, BenchSplit } from '../bench/split.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { useBenchSelection } from '../bench/use-selection.ts';
import { endpointLabel } from './model.ts';
import type { EventsParams } from './use-address.ts';

// The inspector carries the table, dialogs and sheets: it loads when something is selected.
const EndpointInspector = lazy(() =>
  import('./endpoint-inspector.tsx').then((m) => ({ default: m.EndpointInspector })),
);

const idOf = (e: WebhookEndpointDto) => e.id;

const rowOf = (e: WebhookEndpointDto): BenchRowParts => ({
  title: endpointLabel(e),
  meta: e.target === 'capture' ? 'Stored, never sent' : `${e.eventTypes.length} events`,
  trail: (
    <StatusChip status={e.lastStatus} tone={e.status === 'active' ? undefined : 'neutral'}>
      {e.lastStatus ?? e.status}
    </StatusChip>
  ),
});

/** The context's endpoints and the selected one beside them. The selection is the hash. */
export function EndpointsPanel({
  endpoints,
  params,
  write,
  selectNew,
  focusSend,
  empty,
}: {
  endpoints: readonly WebhookEndpointDto[];
  params: EventsParams;
  write: (next: Record<string, string | null>, mode: 'push' | 'replace') => void;
  /** An endpoint just added: the wizard's finish selects it. */
  selectNew: string | undefined;
  focusSend: boolean;
  empty: React.ReactNode;
}) {
  const fetchOne = useCallback(async () => null, []);
  const selection = useBenchSelection({ items: endpoints, idOf, fetchOne, ready: true });
  const { selectedId, selected, step, select } = selection;
  const wide = useMediaQuery(BENCH_WIDE);
  // The wizard's finish writes the address by push, which no hashchange announces.
  useEffect(() => {
    if (selectNew) select(selectNew, { open: true });
  }, [selectNew, select]);
  // Wide, the pane is always there: it opens on the first endpoint.
  const first = endpoints[0];
  useEffect(() => {
    if (wide && !selectedId && first) select(first.id, { open: false });
  }, [wide, selectedId, first, select]);
  const at = selected ? endpoints.findIndex((e) => e.id === selected.id) : -1;
  return (
    <>
      <BenchSlot name="count">{`${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}`}</BenchSlot>
      <BenchSplit
        bare
        label="Endpoints"
        open={selection.open}
        onClose={() => selection.setOpen(false)}
        main={
          <BenchList
            label="Endpoints"
            items={endpoints}
            idOf={idOf}
            selection={selection}
            empty={empty}
            row={rowOf}
            footer={{ count: `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}` }}
          />
        }
        pane={
          selected ? (
            <Suspense fallback={<BenchSkeleton rows={4} />}>
              <EndpointInspector
                endpoint={selected}
                capture={params.capture}
                onCapture={(id) => write({ capture: id ?? null }, 'replace')}
                focusSend={focusSend}
                onGone={() => select(null)}
                onPrev={at > 0 ? () => step(-1) : undefined}
                onNext={at >= 0 && at < endpoints.length - 1 ? () => step(1) : undefined}
              />
            </Suspense>
          ) : null
        }
      />
    </>
  );
}

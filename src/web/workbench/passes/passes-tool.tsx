import { Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { WB_EMPTY } from '@/shared/copy/workbench-states.ts';
import { wbPath } from '@/shared/workbench.ts';
import { copyWithFeedback } from '../../developers/shell/copy.ts';
import { useInsertHighlight } from '../../lib/motion.ts';
import { Button } from '../../ui/button.tsx';
import { SegmentedControl } from '../../ui/segmented-control.tsx';
import { useBenchKeys } from '../bench/keys.ts';
import { BenchList, type BenchRowParts } from '../bench/list.tsx';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchSplit } from '../bench/split.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { useBenchSelection } from '../bench/use-selection.ts';
import { useToolHost } from '../host/tool-host.tsx';
import { WbLink } from '../logs/link.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolEmpty, ToolFailed } from '../states/states.tsx';
import { useDevicePassEnabled } from './flags.ts';
import { stateOf, titleOf, toneOf } from './model.ts';
import { PassInspector } from './pass-inspector.tsx';
import { PassThumb } from './pass-thumb.tsx';
import { PhoneView } from './phone-view.tsx';
import { useAddress } from './use-address.ts';
import { usePassList } from './use-passes.ts';

const idOf = (p: PassSummaryDto) => p.id;
/** The buddy reacts to what this tab caused at most once every 2 s, and for as long as it takes to read. */
const CHEER_MS = 2400;
const CHEER_GAP_MS = 2000;

const rowOf = (p: PassSummaryDto): BenchRowParts => ({
  lead: <PassThumb voided={p.status !== 'active'} />,
  title: titleOf(p),
  meta: p.subtitle ?? undefined,
  trail: (
    <>
      <StatusChip tone={toneOf(p)}>{WB_PASSES.status[stateOf(p)]}</StatusChip>
      <BenchTime at={p.modifiedAt} />
    </>
  ),
});

/** The cheer flag: on for a moment after something this tab caused, never twice within 2 s. */
function useCheer() {
  const [on, setOn] = useState(false);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const cheer = useCallback(() => {
    const now = Date.now();
    if (now - last.current < CHEER_GAP_MS) return;
    last.current = now;
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), CHEER_MS);
  }, []);
  return { on, cheer };
}

/**
 * Passes (design §3.1, T6): the context's Test passes and the selected one beside the list. The
 * inspector is a side pane from 1180 px, an edge-to-edge sheet over a scrim below. `?view=phone`
 * lists passes by their own link as a QR. Everything runs on the Workbench token.
 */
export function PassesTool() {
  const { context } = useToolHost();
  const { orgId } = context;
  const sandbox = context.kind === 'sandbox';
  const list = usePassList();
  const { params, write } = useAddress();
  const cheer = useCheer();
  const devicePass = useDevicePassEnabled(context);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const fresh = useInsertHighlight(items.map(idOf));
  const selection = useBenchSelection({ items, idOf, ready: list.isSuccess });
  const { selected } = selection;
  const showPhone = params.view === 'phone' && (!sandbox || devicePass);
  const ids = useMemo(() => items.map(idOf), [items]);
  const at = selected ? ids.indexOf(selected.id) : -1;

  const newPass = (
    <Button asChild iconStart={<Plus aria-hidden />}>
      <WbLink href={wbPath(orgId, 'design')}>{WB_PASSES.newPass}</WbLink>
    </Button>
  );
  // y copies the selected pass's id.
  useBenchKeys({ copyId: () => selected && void copyWithFeedback(selected.id, null) });

  let body: ReactNode;
  if (list.isPending) body = <BenchSkeleton rows={6} />;
  else if (list.isError)
    body = <ToolFailed error={list.error} onRetry={() => void list.refetch()} />;
  else if (showPhone) body = <PhoneView orgId={orgId} passes={items} />;
  else
    body = (
      <BenchSplit
        bare
        label={WB_PASSES.list.label}
        open={selection.open}
        onClose={() => selection.setOpen(false)}
        main={
          <BenchList
            label={WB_PASSES.list.label}
            items={items}
            idOf={idOf}
            selection={selection}
            fresh={fresh}
            row={rowOf}
            tone={toneOf}
            empty={
              <ToolEmpty
                tool="passes"
                action={
                  <Button asChild variant="outline">
                    <WbLink href={wbPath(orgId, 'design')}>{WB_EMPTY.passes?.action}</WbLink>
                  </Button>
                }
              />
            }
            footer={{
              count: WB_PASSES.list.count(items.length),
              ...(list.hasNextPage
                ? { onMore: () => void list.fetchNextPage(), loading: list.isFetchingNextPage }
                : {}),
            }}
          />
        }
        pane={
          selected ? (
            <PassInspector
              pass={selected}
              orgId={orgId}
              sandbox={sandbox}
              tab={params.tab}
              onTab={(tab) => write({ tab: tab === 'events' ? null : tab })}
              cheering={cheer.on}
              onCheer={cheer.cheer}
              onPrev={at > 0 ? () => selection.step(-1) : undefined}
              onNext={at >= 0 && at < ids.length - 1 ? () => selection.step(1) : undefined}
            />
          ) : null
        }
      />
    );

  return (
    <ToolPage
      tool="passes"
      primary={newPass}
      count={list.isSuccess ? WB_PASSES.list.count(items.length) : undefined}
    >
      <div className="wb-tool-passes flex min-w-0 flex-col gap-3">
        {sandbox && !devicePass ? null : (
          <SegmentedControl
            label={WB_PASSES.view.label}
            options={[
              { value: 'all', label: WB_PASSES.view.all },
              { value: 'phone', label: WB_PASSES.view.phone },
            ]}
            value={showPhone ? 'phone' : 'all'}
            onValueChange={(v) => write({ view: v === 'phone' ? 'phone' : null })}
            className="self-start"
          />
        )}
        {body}
      </div>
    </ToolPage>
  );
}

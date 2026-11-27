import { type ReactNode, useMemo } from 'react';
import { WB_ACTIVITY } from '@/shared/copy/workbench-inbox.ts';
import { isOperationActive } from '../../lib/status-operations.ts';
import { OperationsProvider } from '../../ui/operation/client.ts';
import { OperationProgress } from '../../ui/operation/operation-progress.tsx';
import { OperationRow } from '../../ui/operation/operation-row.tsx';
import { useCachedOperation } from '../../ui/operation/store.ts';
import type { Operation } from '../../ui/operation/types.ts';
import { useOperationActions } from '../../ui/operation/use-tray.ts';
import { useNow } from '../../ui/rel-time.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { useBenchKeys } from '../bench/keys.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { BenchSplit } from '../bench/split.tsx';
import { useBenchSelection } from '../bench/use-selection.ts';
import { useToolHost } from '../host/tool-host.tsx';
import { useBenchRouter } from '../inbox/use-bench-router.ts';
import { ToolPage } from '../shell/tool-page.tsx';
import { ToolEmpty, ToolFailed } from '../states/states.tsx';
import { useActivity } from './use-activity.ts';
import '../bench/bench.css';
import '../bench/pane.css';
import './activity.css';

const idOf = (op: Operation) => op.id;

function Pane({
  op,
  onPrev,
  onNext,
  refetch,
}: {
  op: Operation;
  onPrev?: () => void;
  onNext?: () => void;
  refetch: () => void;
}) {
  const cached = useCachedOperation(op.id);
  const current = cached && cached.revision >= op.revision ? cached : op;
  const { stop, retry, retrying } = useOperationActions();
  const act = (run: (o: Operation) => Promise<void>) => async () => {
    await run(current);
    refetch();
  };
  return (
    <Inspector
      title={current.title}
      label={`Operation ${current.title}`}
      itemKey={current.id}
      onPrev={onPrev}
      onNext={onNext}
    >
      <div className="activity-detail">
        <OperationProgress
          operation={current}
          buddy={false}
          retrying={retrying}
          onStop={current.cancelable ? act(stop) : undefined}
          onRetry={current.status === 'failed' && current.error?.retryable ? act(retry) : undefined}
        />
      </div>
    </Inspector>
  );
}

function List({
  items,
  selection,
}: {
  items: readonly Operation[];
  selection: ReturnType<typeof useBenchSelection<Operation>>;
}) {
  const now = useNow(
    1000,
    items.some((op) => isOperationActive(op.status)),
  );
  const active = items.filter((op) => isOperationActive(op.status));
  const earlier = items.filter((op) => !isOperationActive(op.status));
  const group = (label: string, ops: readonly Operation[]): ReactNode =>
    ops.length === 0 ? null : (
      <section className="activity-group" aria-label={label}>
        <h2 className="activity-h">{label}</h2>
        <ul className="activity-rows">
          {ops.map((op) => (
            <li key={op.id} data-selected={op.id === selection.selectedId || undefined}>
              <OperationRow
                operation={op}
                now={now}
                elapsed={isOperationActive(op.status)}
                onOpen={(o) => selection.select(o.id, { open: true })}
              />
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="activity-list">
      {group(WB_ACTIVITY.running, active)}
      {group(active.length > 0 ? WB_ACTIVITY.earlier : WB_ACTIVITY.list, earlier)}
    </div>
  );
}

function Body() {
  const { context, operations } = useToolHost();
  const { items, phase, refetch } = useActivity(context.orgId);
  useBenchRouter();
  const selection = useBenchSelection({ items, idOf, ready: phase === 'ready' });
  const selected = selection.selected;
  const at = selected ? items.findIndex((o) => o.id === selected.id) : -1;
  useBenchKeys({
    next: () => selection.step(1),
    prev: () => selection.step(-1),
    close: () => {
      if (selection.open) selection.setOpen(false);
    },
  });
  void operations;
  let body: ReactNode;
  if (phase === 'loading') body = <BenchSkeleton rows={4} />;
  else if (phase === 'failed')
    body = <ToolFailed error={new Error('activity')} onRetry={refetch} />;
  else if (items.length === 0) body = <ToolEmpty tool="activity" />;
  else {
    const count = WB_ACTIVITY.count(items.length);
    body = (
      <>
        <BenchSlot name="count">{count}</BenchSlot>
        <BenchSplit
          main={<List items={items} selection={selection} />}
          pane={
            selected ? (
              <Pane
                op={selected}
                refetch={refetch}
                onPrev={at > 0 ? () => selection.step(-1) : undefined}
                onNext={at >= 0 && at < items.length - 1 ? () => selection.step(1) : undefined}
              />
            ) : (
              <p className="activity-none">{WB_ACTIVITY.select}</p>
            )
          }
          open={selection.open && selected !== null}
          onClose={() => selection.setOpen(false)}
          label={WB_ACTIVITY.list}
          bare
        />
      </>
    );
  }
  return <ToolPage tool="activity">{body}</ToolPage>;
}

/** Every Test operation in this context, with Stop and Retry through the token: the tray's full list. */
export function ActivityPage() {
  const { operations } = useToolHost();
  const client = useMemo(() => operations, [operations]);
  return (
    <OperationsProvider client={client}>
      <Body />
    </OperationsProvider>
  );
}

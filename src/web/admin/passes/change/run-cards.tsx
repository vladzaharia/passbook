import { Square, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { Button, Card, CardBody } from '../../../ui/index.ts';
import { RunDone, RunProgress, RunStats, UndoPanel } from '../run-kit.tsx';
import { CHANGE_COPY as C } from './copy.ts';

export const handledOf = (b: BroadcastDto) =>
  b.counts.updated + b.counts.unchanged + b.counts.failed;

/** Changed, Already set, Failed and Silent: a run's counters. */
export function Counters({ b }: { b: BroadcastDto }) {
  return (
    <RunStats
      stats={[
        { label: C.run.created, value: b.counts.updated },
        { label: C.run.unchanged, value: b.counts.unchanged },
        { label: C.run.failed, value: b.counts.failed, tone: 'danger' },
        { label: C.run.silent, value: b.counts.overBudget },
      ]}
    />
  );
}

/** A running change: the shared run bar, the counters and Stop. The page polls. */
export function RunningCard({
  b,
  stopping,
  onStop,
  stopBusy,
}: {
  b: BroadcastDto;
  stopping: boolean;
  onStop?: (() => void) | undefined;
  stopBusy: boolean;
}) {
  const total = Math.max(b.counts.targeted, 1);
  const done = Math.min(handledOf(b), total);
  return (
    <Card>
      <CardBody className="flex flex-col gap-5 p-6">
        <RunProgress
          done={done}
          total={total}
          text={C.run.running(done, b.counts.targeted)}
          aside={<p className="text-sm text-fg-muted">{stopping ? C.run.stopping : C.run.leave}</p>}
        />
        <Counters b={b} />
        {onStop ? (
          <div>
            <Button
              variant="outline"
              iconStart={<Square aria-hidden />}
              loading={stopBusy}
              disabled={stopping}
              onClick={onStop}
            >
              {C.run.stop}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** A finished change, in the shared done card. */
export function DoneCard({
  b,
  undone,
  children,
}: {
  b: BroadcastDto;
  undone: boolean;
  children: ReactNode;
}) {
  const failed = b.state === 'failed' || b.state === 'cancelled';
  return (
    <RunDone
      clean={b.state === 'sent' && b.counts.failed === 0}
      undone={undone}
      failed={failed && !undone}
      title={
        undone
          ? C.run.undoneTitle
          : b.state === 'cancelled'
            ? C.run.stopped
            : failed
              ? C.run.failedTitle
              : C.run.doneTitle(b.counts.updated)
      }
    >
      <Counters b={b} />
      {children}
    </RunDone>
  );
}

/** The undo window: a deadline, what it does, and the button. */
export function UndoBar({
  until,
  busy,
  onUndo,
}: {
  until: string;
  busy: boolean;
  onUndo: () => void;
}) {
  return (
    <UndoPanel
      actions={
        <Button variant="outline" loading={busy} iconStart={<Undo2 aria-hidden />} onClick={onUndo}>
          {C.run.undo}
        </Button>
      }
    >
      <b className="text-fg-strong">{C.run.undoUntil(until)}</b> · {C.run.undoSilent}
    </UndoPanel>
  );
}

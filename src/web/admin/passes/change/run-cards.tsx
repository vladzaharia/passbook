import { Check, Square, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { cn } from '../../../lib/cn.ts';
import {
  Buddy,
  Button,
  Card,
  CardBody,
  Celebrate,
  CountUp,
  ProgressBar,
} from '../../../ui/index.ts';
import './change.css';
import { CHANGE_COPY as C } from './copy.ts';

export const handledOf = (b: BroadcastDto) =>
  b.counts.updated + b.counts.unchanged + b.counts.failed;

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <dd
        className={cn(
          'text-2xl font-semibold text-fg-strong',
          tone === 'danger' && value > 0 && 'text-danger',
        )}
      >
        <CountUp value={value} />
      </dd>
      <dt className="text-xs text-fg-muted">{label}</dt>
    </div>
  );
}

/** Changed, Already set, Failed and Silent: a run's counters. */
export function Counters({ b }: { b: BroadcastDto }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label={C.run.created} value={b.counts.updated} />
      <Stat label={C.run.unchanged} value={b.counts.unchanged} />
      <Stat label={C.run.failed} value={b.counts.failed} tone="danger" />
      <Stat label={C.run.silent} value={b.counts.overBudget} />
    </dl>
  );
}

/** A running change: the foil bar with the buddy riding it, and Stop. The page polls. */
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
  const text = C.run.running(done, b.counts.targeted);
  return (
    <Card>
      <CardBody className="flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p aria-live="polite" className="text-base font-semibold tabular-nums text-fg-strong">
            {text}
          </p>
          <p className="text-sm text-fg-muted">{stopping ? C.run.stopping : C.run.leave}</p>
        </div>
        <div data-art-host="" className="wl-buddy-room relative [--wl-buddy-room:3.5rem]">
          <span
            aria-hidden
            className="absolute top-0 h-1.5 w-0 motion-safe:transition-[left] motion-safe:duration-(--wl-dur-enter) motion-safe:ease-(--wl-ease-move)"
            style={{ left: `${(done / total) * 100}%` }}
          >
            <Buddy scene="count" size="sm" />
          </span>
          <ProgressBar
            label="Passes handled"
            value={done}
            max={total}
            valueText={text}
            className="wl-foil-bar"
          />
        </div>
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

/** A finished change: the buddy cheers once on a clean run, looks sorry on a failed one, peeks after an undo. */
export function DoneCard({
  b,
  undone,
  children,
}: {
  b: BroadcastDto;
  undone: boolean;
  children: ReactNode;
}) {
  const clean = b.state === 'sent' && b.counts.failed === 0 && !undone;
  const failed = b.state === 'failed' || b.state === 'cancelled';
  return (
    <Card data-art-host="" className="wl-buddy-room relative">
      <Buddy
        scene={undone ? 'peek' : clean ? 'cheer' : 'sorry'}
        mood={undone || clean ? 'happy' : 'sad'}
        size="sm"
      />
      <Celebrate when={clean} />
      <CardBody className="flex flex-col gap-5 p-6">
        <p className="flex items-center gap-2 text-base font-semibold text-fg-strong">
          <span
            className={cn(
              'wl-step-done inline-flex size-6 items-center justify-center rounded-full text-accent-on',
              failed ? 'bg-danger' : 'bg-success',
            )}
          >
            <Check aria-hidden className="size-4" />
          </span>
          {undone
            ? C.run.undoneTitle
            : b.state === 'cancelled'
              ? C.run.stopped
              : failed
                ? C.run.failedTitle
                : C.run.doneTitle(b.counts.updated)}
        </p>
        <Counters b={b} />
        {children}
      </CardBody>
    </Card>
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-border p-4">
      <p className="min-w-0 flex-1 text-sm text-fg-muted">
        <b className="text-fg-strong">{C.run.undoUntil(until)}</b> · {C.run.undoSilent}
      </p>
      <Button variant="outline" loading={busy} iconStart={<Undo2 aria-hidden />} onClick={onUndo}>
        {C.run.undo}
      </Button>
    </div>
  );
}

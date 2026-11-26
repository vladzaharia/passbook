import { type ReactNode, useEffect, useRef, useState } from 'react';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { cn } from '../../lib/cn.ts';
import { formatTime } from '../../lib/format.ts';
import { isOperationActive } from '../../lib/status-operations.ts';
import { Buddy, type BuddyScene } from '../art/index.ts';
import { TechnicalDetails } from '../key-value.tsx';
import { useNow } from '../rel-time.tsx';
import { StepList } from '../step-marker.tsx';
import { type PanelActions, PanelButtons } from './panel-actions.tsx';
import { RunBar } from './run-bar.tsx';
import { announceKey, announcement, stepItems } from './steps.ts';
import { useRegisterOperationPanel } from './store.ts';
import { elapsedMs, formatClock, stepMeta } from './text.ts';
import type { Operation, OperationStatus } from './types.ts';

const BUDDY: Record<OperationStatus, { scene: BuddyScene; mood?: 'happy' | 'sad' }> = {
  queued: { scene: 'beat' },
  running: { scene: 'busy' },
  waiting: { scene: 'beat' },
  succeeded: { scene: 'cheer', mood: 'happy' },
  failed: { scene: 'sorry', mood: 'sad' },
  cancelled: { scene: 'beat' },
};

export interface OperationProgressProps extends PanelActions {
  operation: Operation;
  /** `card` takes a card's body (the quickstart's step, the Workbench's sandbox card). */
  framing?: 'plain' | 'card';
  /** Shows "Started 2:14 PM" in this zone: the org's, else America/Los_Angeles. Never UTC. */
  zone?: string;
  /** One line under the title once it is done ("Data is erased by Dec 2."). */
  doneNote?: ReactNode;
  /** A retry is in flight. */
  retrying?: boolean;
  /** The page has its own buddy: draw none here (one buddy per view). */
  buddy?: boolean;
  className?: string;
}

/**
 * A long action, live: the exact current step with its count, how long it has run, the buddy, and
 * every step with its state. The same panel in admin, the holder portal and the developer site: it
 * takes an `Operation` from the server (useOperation) or the local driver (useLocalOperation) and
 * imports nothing from a space. One polite live region says each step start, a wait and the end,
 * never a count. Reduced motion drops the buddy loop and the bar slide; spinners keep turning.
 */
export function OperationProgress({
  operation: op,
  framing = 'plain',
  zone,
  doneNote,
  retrying,
  buddy = true,
  className,
  ...actions
}: OperationProgressProps) {
  const now = useNow(1000, op.status === 'running' || op.status === 'waiting');
  useRegisterOperationPanel(op.id);

  // The live region is mounted with the panel and empty, so the first line is a change it announces.
  const [said, setSaid] = useState('');
  const key = announceKey(op);
  // biome-ignore lint/correctness/useExhaustiveDependencies: counts change `op`; only `key` says a step began.
  useEffect(() => setSaid(announcement(op)), [key]);

  // Focus follows a success that happens while the panel is open: the next action, else the title.
  const heading = useRef<HTMLParagraphElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const was = useRef(op.status);
  useEffect(() => {
    if (op.status === 'succeeded' && isOperationActive(was.current))
      (nextRef.current ?? heading.current)?.focus();
    was.current = op.status;
  }, [op.status]);

  // The buddy acts its state once per change; a retry replays it.
  const [replay, setReplay] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the status is the trigger.
  useEffect(() => setReplay((n) => n + 1), [op.status, op.attempt]);

  const step = op.steps.find((s) => s.key === op.step);
  const bar =
    op.status === 'running' && step && step.total !== null && step.total > 0 ? step : null;
  const { scene, mood } = BUDDY[op.status];
  const headline = {
    queued: 'Starting',
    running: op.text,
    waiting: op.text,
    succeeded: op.text,
    failed: op.text,
    cancelled: 'Stopped',
  }[op.status];
  const sub =
    op.status === 'succeeded'
      ? `Took ${formatClock(elapsedMs(op, now))}`
      : op.status === 'cancelled' && op.text && op.text !== 'Stopped'
        ? op.text
        : op.status === 'waiting' && step
          ? stepMeta(step, now, zone, false)
          : null;
  const hasActions = !!(
    actions.onClose ||
    actions.onRetry ||
    actions.next ||
    actions.onBackground ||
    (actions.onStop && op.cancelable)
  );

  return (
    <section
      data-art-host=""
      data-operation={op.status}
      aria-label={op.title}
      className={cn(
        'relative flex flex-col gap-5',
        buddy && !bar && 'wl-buddy-room [--wl-buddy-room:3.5rem]',
        framing === 'card' && 'rounded-lg border border-border bg-surface-raised p-5',
        className,
      )}
    >
      {buddy && !bar ? (
        <Buddy size="sm" at="end" scene={scene} mood={mood} replay={replay} />
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <p
            ref={heading}
            data-headline=""
            tabIndex={-1}
            className="min-w-0 text-base font-semibold text-fg-strong outline-none"
          >
            {headline}
          </p>
          {op.status === 'running' && op.startedAt !== null ? (
            <span aria-hidden className="shrink-0 font-mono text-xs tabular-nums text-fg-muted">
              {formatClock(elapsedMs(op, now))}
            </span>
          ) : null}
        </div>
        {sub ? <p className="text-sm tabular-nums text-fg-muted">{sub}</p> : null}
        {op.status === 'succeeded' && doneNote ? (
          <p className="text-sm text-fg-muted">{doneNote}</p>
        ) : null}
      </div>
      {bar ? (
        <RunBar
          done={bar.done ?? 0}
          total={bar.total ?? 0}
          label={bar.label}
          scene="busy"
          buddy={buddy}
        />
      ) : null}
      <StepList label={op.title} items={stepItems(op, now, zone)} />
      {op.status === 'failed' && op.error ? (
        <TechnicalDetails
          items={[
            { label: 'Code', value: op.error.code, mono: true },
            { label: 'Operation', value: op.id, mono: true, copy: true },
            { label: 'Attempt', value: String(op.attempt) },
            ...(op.startedAt !== null
              ? [
                  {
                    label: 'Started',
                    value: formatTime(op.startedAt, zone ?? DEFAULT_TIME_ZONE),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
      {hasActions ? (
        <PanelButtons op={op} actions={actions} nextRef={nextRef} retrying={retrying} />
      ) : null}
    </section>
  );
}

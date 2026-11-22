import { Check, X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { cn } from '../../lib/cn.ts';
import { Buddy, Card, CardBody, Celebrate, CountUp, ProgressBar } from '../../ui/index.ts';

/** The foil bar with the buddy riding it: a run's progress. The page polls; the bar moves to match. */
export function RunProgress({
  done,
  total,
  text,
  meta,
  aside,
}: {
  done: number;
  total: number;
  text: string;
  /** Muted, beside the count: time left. */
  meta?: ReactNode;
  /** Right of the count: "You can leave this page." */
  aside?: ReactNode;
}) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p aria-live="polite" className="text-base font-semibold tabular-nums text-fg-strong">
          {text}
          {meta ? <span className="font-normal text-fg-muted"> · {meta}</span> : null}
        </p>
        {aside}
      </div>
      <div data-art-host="" className="wl-buddy-room relative [--wl-buddy-room:3.5rem]">
        <span
          aria-hidden
          className="absolute top-0 h-1.5 w-0 motion-safe:transition-[left] motion-safe:duration-(--wl-dur-enter) motion-safe:ease-(--wl-ease-move)"
          style={{ left: `${share * 100}%` }}
        >
          <Buddy scene="count" size="sm" />
        </span>
        <ProgressBar
          label="Passes handled"
          value={done}
          max={Math.max(total, 1)}
          valueText={text}
          tone="foil"
        />
      </div>
    </>
  );
}

export interface RunStat {
  label: string;
  value: number;
  tone?: 'danger';
}

/** A run's counters, counting up to their values. */
export function RunStats({ stats }: { stats: readonly RunStat[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex flex-col-reverse rounded-md border border-border bg-surface-sunken p-3"
        >
          <dt className="text-xs text-fg-muted">{s.label}</dt>
          <dd
            className={cn(
              'text-2xl font-semibold text-fg-strong',
              s.tone === 'danger' && s.value > 0 && 'text-danger',
            )}
          >
            <CountUp value={s.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A finished run: the buddy cheers once on a clean run, looks sorry on a failed one and peeks after an
 * undo; the title carries a check (red when it failed).
 */
export function RunDone({
  title,
  clean,
  undone,
  failed,
  buddy = true,
  children,
}: {
  title: string;
  clean: boolean;
  undone: boolean;
  failed?: boolean;
  buddy?: boolean;
  children: ReactNode;
}) {
  const celebrated = useRef(clean && !undone);
  return (
    <Card data-art-host="" className="wl-buddy-room relative">
      {buddy ? (
        <Buddy
          scene={undone ? 'peek' : clean ? 'cheer' : 'sorry'}
          mood={undone || clean ? 'happy' : 'sad'}
          size="sm"
        />
      ) : null}
      <Celebrate when={celebrated.current} />
      <CardBody className="flex flex-col gap-5 p-6">
        <p className="flex items-center gap-2 text-base font-semibold text-fg-strong">
          <span
            className={cn(
              'wl-step-done inline-flex size-6 items-center justify-center rounded-full text-accent-on',
              failed ? 'bg-danger' : 'bg-success',
            )}
          >
            {failed ? (
              <X aria-hidden className="size-4" />
            ) : (
              <Check aria-hidden className="size-4" />
            )}
          </span>
          {title}
        </p>
        {children}
      </CardBody>
    </Card>
  );
}

/** The undo window's frame: a lead (ring, deadline) and its actions. */
export function UndoPanel({
  lead,
  children,
  actions,
}: {
  lead?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-border p-4">
      {lead}
      <p className="min-w-0 flex-1 text-sm text-fg-muted">{children}</p>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

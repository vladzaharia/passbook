import { Check, X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { cn } from '../../lib/cn.ts';
import { Buddy, Card, CardBody, Celebrate, CountUp } from '../../ui/index.ts';

/** The run's bar moved to the kit (ui/operation/run-bar.tsx); pages keep this name. */
export { RunBar as RunProgress } from '../../ui/operation/run-bar.tsx';

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
      <Celebrate
        when={celebrated.current}
        at={buddy ? 'buddy' : 'center'}
        delay={buddy ? 440 : 0}
        size={buddy ? 'lg' : 'sm'}
      />
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
      <p className="min-w-0 flex-1 basis-48 text-sm text-fg-muted">{children}</p>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

import { Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { useChangeCount } from '../lib/motion.ts';
import { IconButton } from './icon-button.tsx';

export interface ChecklistStep {
  id: string;
  label: ReactNode;
  /** From data, never from a click: the step checks itself. */
  done: boolean;
  /** The next action (a link or button) while the step is open. */
  action?: ReactNode;
}

function Mark({ index, done }: { index: number; done: boolean }) {
  const changed = useChangeCount(done);
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
        done ? 'border-accent bg-accent text-accent-on' : 'border-border-strong text-fg-muted',
      )}
    >
      {done ? (
        <Check key={changed} className={cn('size-3.5', changed > 0 && 'wl-check')} />
      ) : (
        index + 1
      )}
    </span>
  );
}

/** Numbered next steps ("Get started"): each checks itself from props; optional dismiss. */
export function Checklist({
  title,
  steps,
  onDismiss,
  className,
}: {
  title: string;
  steps: readonly ChecklistStep[];
  onDismiss?: () => void;
  className?: string;
}) {
  const left = steps.filter((s) => !s.done).length;
  return (
    <section aria-label={title} className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg-strong">{title}</h2>
        {onDismiss ? (
          <IconButton label="Dismiss" size="sm" icon={<X aria-hidden />} onClick={onDismiss} />
        ) : null}
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={step.id} className="flex min-h-11 items-center gap-3">
            <Mark index={i} done={step.done} />
            <span
              className={cn(
                'min-w-0 flex-1 text-sm',
                step.done ? 'text-fg-muted line-through decoration-fg-subtle' : 'text-fg-strong',
              )}
            >
              {step.label}
              <span className="sr-only">{step.done ? ' (done)' : ''}</span>
            </span>
            {step.done ? null : step.action}
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">
        {left === 0 ? 'All steps done' : `${left} of ${steps.length} left`}
      </p>
    </section>
  );
}

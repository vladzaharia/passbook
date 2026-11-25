import type { CSSProperties } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { Tick } from '@/web/ui/checkbox.tsx';

export interface KeyStep {
  id: string;
  title: string;
  /** What was chosen, shown under a done step. */
  summary?: string | undefined;
}

/**
 * The wizard's rail: numbered steps down the left of the dialog (done steps are buttons back to
 * them); below 768 one line, "Step 2 of 4", over a thin progress bar.
 */
export function KeyStepper({
  steps,
  current,
  onStep,
}: {
  steps: readonly KeyStep[];
  current: number;
  onStep: (index: number) => void;
}) {
  const step = steps[current];
  return (
    <nav aria-label="Steps" className="md:w-52 md:shrink-0">
      <div className="md:hidden">
        <p className="text-sm text-fg-muted">
          Step {current + 1} of {steps.length}
          {step ? <span className="text-fg-strong"> · {step.title}</span> : null}
        </p>
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-border">
          <div
            className="wl-fill h-full origin-left rounded-full bg-accent"
            style={{ transform: `scaleX(${(current + 1) / steps.length})` } as CSSProperties}
          />
        </div>
      </div>
      <ol className="relative flex flex-col max-md:hidden">
        {steps.map((s, i) => {
          const done = i < current;
          const here = i === current;
          const last = i === steps.length - 1;
          const body = (
            <>
              <span
                className={cn(
                  'relative z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums wl-colors',
                  done && 'wl-step-done border-accent bg-accent text-accent-on',
                  here && 'border-accent bg-surface-overlay text-accent-fg',
                  !done && !here && 'border-border-strong bg-surface-overlay text-fg-muted',
                )}
              >
                {done ? <Tick draw className="size-3.5" /> : i + 1}
              </span>
              <span className="flex min-w-0 flex-col pt-0.5 text-left">
                <span
                  className={cn(
                    'text-sm',
                    here ? 'font-medium text-fg-strong' : done ? 'text-fg' : 'text-fg-muted',
                  )}
                >
                  {s.title}
                </span>
                {done && s.summary ? (
                  <span className="truncate text-xs text-fg-muted">{s.summary}</span>
                ) : null}
              </span>
            </>
          );
          return (
            <li key={s.id} className={cn('relative', !last && 'pb-6')}>
              {last ? null : (
                <span
                  aria-hidden
                  className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border"
                >
                  <span
                    className="wl-fill absolute inset-0 origin-top bg-accent"
                    style={{ transform: `scaleY(${done ? 1 : 0})` } as CSSProperties}
                  />
                </span>
              )}
              {done ? (
                <button
                  type="button"
                  onClick={() => onStep(i)}
                  className="flex w-full items-start gap-3 rounded-md hover:[&_span:last-child>span:first-child]:text-fg-strong"
                >
                  {body}
                </button>
              ) : (
                <div aria-current={here ? 'step' : undefined} className="flex items-start gap-3">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

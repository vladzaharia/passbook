import { Check } from 'lucide-react';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { cn } from '@/web/lib/cn.ts';

/**
 * A run as steps: done ones tick, the current one is ringed, the rest wait. Apple's managed ID
 * and Google's managed issuer draw the same list.
 */
export function RunSteps({
  labels,
  at,
  failed,
}: {
  labels: readonly string[];
  /** Index of the current step; the length means every step is done. */
  at: number;
  failed: boolean;
}) {
  return (
    <ol aria-label="Setup steps" className="wl-stagger m-0 flex list-none flex-col gap-2 p-0">
      {labels.map((label, i) => {
        const done = i < at;
        const now = i === at;
        return (
          <li
            key={label}
            style={{ '--i': i } as never}
            className={cn(
              'flex items-center gap-2 text-sm',
              done || now ? 'text-fg' : 'text-fg-muted',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'inline-flex size-5 items-center justify-center rounded-full border text-xs',
                done
                  ? 'wl-step-done border-success-border bg-success-subtle text-success'
                  : now && !failed
                    ? 'border-accent text-accent-fg'
                    : 'border-border-strong',
              )}
            >
              {done ? <Check className="size-3" /> : i + 1}
            </span>
            {label}
            {now ? (
              <span className="sr-only">
                {failed ? PASS_SETUP_COPY.channelsCard.runFailed : 'In progress'}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

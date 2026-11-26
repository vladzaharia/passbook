import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { WB_HOME_COPY as C } from '../../../shared/copy/workbench-home.ts';
import { wbPath } from '../../../shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { BuddyFace } from '../../ui/art/face.tsx';
import { Button } from '../../ui/button.tsx';
import { CARD_SURFACE } from '../../ui/card.tsx';

/** Quickstart's first two steps (sign in, sandbox) are done once there is a sandbox; the card names the third on. */
const FIRST_OPEN = 2;

/**
 * The next step, until Quickstart is done (sandbox only). The face hops when a step completes while
 * Home is open; it never plays on first paint.
 */
export function NextStep({
  orgId,
  done,
  total,
  seat,
}: {
  orgId: string;
  done: number;
  total: number;
  seat?: ReactNode;
}) {
  if (done >= total) return null;
  const step = C.next.steps[Math.min(Math.max(done - FIRST_OPEN, 0), C.next.steps.length - 1)];
  if (!step) return null;
  return (
    <section
      aria-labelledby="wb-home-next"
      className={cn(
        CARD_SURFACE,
        'relative flex h-full min-w-0 flex-wrap items-center gap-x-4 gap-y-3 p-4',
      )}
    >
      {seat ? <div className="absolute top-8 left-8 size-0">{seat}</div> : null}
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-accent-subtle">
        <BuddyFace scene="hop" size="md" mood="curious" replay={done} className="size-9" />
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-xs font-medium text-fg-muted">{C.next.label}</p>
        <h2 id="wb-home-next" className="text-base font-semibold text-fg-strong">
          {step.title}
        </h2>
        <ol
          className="m-0 mt-2 flex list-none flex-wrap items-center gap-1 p-0"
          aria-label={C.next.progress(done, total)}
        >
          {Array.from({ length: total }, (_, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of ticks
              key={i}
              aria-hidden
              className={cn(
                'grid h-1.5 w-8 place-items-center rounded-full transition-colors',
                i < done ? 'bg-accent' : 'bg-state-hover-tint',
              )}
            />
          ))}
          <li className="ml-2 flex items-center gap-1 font-mono text-xs whitespace-nowrap text-fg-muted">
            <Check aria-hidden className="size-3" />
            {C.next.progress(done, total)}
          </li>
        </ol>
      </div>
      <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
        <Button asChild>
          <Link to={wbPath(orgId, step.tool)}>{step.action}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={wbPath(orgId, 'console')}>{C.next.console}</Link>
        </Button>
      </div>
    </section>
  );
}

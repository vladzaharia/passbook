import type { ReactNode } from 'react';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { cn } from '../../lib/cn.ts';
import { Card, CardHeader } from '../../ui/card.tsx';
import { benchTimeText } from '../bench/time.tsx';

/** A Home section: the kit card with its title and one link. `seat` holds a milestone's sparks. */
export function Panel({
  title,
  actions,
  seat,
  className,
  children,
}: {
  title: string;
  actions?: ReactNode;
  seat?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader title={title} actions={actions} />
      {seat ? <div className="absolute top-6 right-8 size-0">{seat}</div> : null}
      {children}
    </Card>
  );
}

/** A moment of the day in the org's zone (America/Los_Angeles until an org sets its own), full moment on hover. */
export function At({ at, now }: { at: number; now: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={benchTimeText(at, DEFAULT_TIME_ZONE, 'full', now)}
      className="font-mono text-xs text-fg-muted tabular-nums"
    >
      {benchTimeText(at, DEFAULT_TIME_ZONE, 'auto', now)}
    </time>
  );
}

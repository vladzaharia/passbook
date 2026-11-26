import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { Card, CardHeader } from '../../ui/card.tsx';
import { benchTimeText } from '../bench/time.tsx';
import { useToolHost } from '../host/tool-host.tsx';

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

/** A moment of the day in the org's zone , full moment on hover. */
export function At({ at, now }: { at: number; now: number }) {
  const zone = useToolHost().context.timeZone;
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={benchTimeText(at, zone, 'full', now)}
      className="font-mono text-xs text-fg-muted tabular-nums"
    >
      {benchTimeText(at, zone, 'auto', now)}
    </time>
  );
}

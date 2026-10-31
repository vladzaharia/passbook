import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import type { Tone } from '../lib/status.ts';

export interface TimelineItem {
  id: string;
  title: ReactNode;
  /** Epoch ms or a pre-formatted string. */
  time: number | string;
  description?: ReactNode;
  tone?: Tone;
}

const DOT: Record<Tone, string> = {
  neutral: 'bg-border-strong',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

export function formatTime(time: number | string): string {
  return typeof time === 'number' ? new Date(time).toLocaleString() : time;
}

export function Timeline({
  items,
  className,
}: {
  items: readonly TimelineItem[];
  className?: string;
}) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {items.map((item) => (
        <li key={item.id} className="relative flex gap-3 pb-4 last:pb-0">
          <span
            aria-hidden
            className="absolute top-3 bottom-0 left-[5px] w-px bg-border last:hidden"
          />
          <span
            aria-hidden
            className={cn(
              'relative mt-1.5 size-3 shrink-0 rounded-full',
              DOT[item.tone ?? 'neutral'],
            )}
          />
          <div className="min-w-0">
            <p className="text-sm text-fg-strong">{item.title}</p>
            <time
              className="text-xs text-fg-muted"
              dateTime={
                typeof item.time === 'number' ? new Date(item.time).toISOString() : undefined
              }
            >
              {formatTime(item.time)}
            </time>
            {item.description ? (
              <p className="mt-0.5 text-sm text-fg-muted">{item.description}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

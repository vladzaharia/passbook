import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { actionOf } from '../lib/actions.ts';
import { cn } from '../lib/cn.ts';
import { formatDateTime } from '../lib/format.ts';
import { useInsertHighlight } from '../lib/motion.ts';
import type { Tone } from '../lib/status.ts';
import { EntityChip, type EntityChipProps } from './entity.tsx';

export interface TimelineItem {
  id: string;
  /** Audit action code: sets the default title, glyph and tone (lib/actions.ts). */
  action?: string;
  title?: ReactNode;
  /** Epoch ms or a pre-formatted string. */
  time: number | string;
  /** Who did it, as an entity chip. */
  actor?: EntityChipProps;
  /** What it was done to, as an entity chip. */
  target?: EntityChipProps;
  /** Plain actor text when there is no entity (system, API). */
  actorLabel?: ReactNode;
  description?: ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
}

const DOT: Record<Tone, string> = {
  neutral: 'border-border-strong bg-surface-sunken text-fg-muted',
  accent: 'border-accent bg-accent-subtle text-accent-fg',
  success: 'border-success-border bg-success-subtle text-success',
  warning: 'border-warning-border bg-warning-subtle text-warning',
  danger: 'border-danger-border bg-danger-subtle text-danger',
  info: 'border-info-border bg-info-subtle text-info',
};

export function formatTime(time: number | string): string {
  return typeof time === 'number' ? formatDateTime(time) : time;
}

/**
 * Events with their action glyph in a 20 px tone dot. The rail draws once; entries new since the
 * last render slide in 6 px and get the insert highlight. Static under reduced motion.
 */
export function Timeline({
  items,
  className,
}: {
  items: readonly TimelineItem[];
  className?: string;
}) {
  const fresh = useInsertHighlight(items.map((i) => i.id));
  return (
    <ol className={cn('flex flex-col', className)}>
      {items.map((item) => {
        const action = item.action ? actionOf(item.action) : undefined;
        const Icon = item.icon ?? action?.icon;
        const tone = item.tone ?? action?.tone ?? 'neutral';
        const isNew = fresh.has(item.id);
        return (
          <li
            key={item.id}
            data-new={isNew ? '' : undefined}
            className={cn('group relative flex gap-3 pb-4 last:pb-0', isNew && 'wl-tl-new')}
          >
            <span
              aria-hidden
              className="wl-rail-draw absolute top-6 bottom-1 left-[9.5px] w-px bg-border group-last:hidden"
            />
            <span
              aria-hidden
              className={cn(
                'relative inline-flex size-5 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3',
                DOT[tone],
              )}
            >
              {Icon ? <Icon /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg-strong">{item.title ?? action?.label}</p>
              <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
                {item.actor ? <EntityChip {...item.actor} /> : item.actorLabel}
                {item.actor || item.actorLabel ? <span aria-hidden>·</span> : null}
                <time
                  dateTime={
                    typeof item.time === 'number' ? new Date(item.time).toISOString() : undefined
                  }
                >
                  {formatTime(item.time)}
                </time>
              </p>
              {item.target ? (
                <p className="mt-1 text-xs">
                  <EntityChip {...item.target} />
                </p>
              ) : null}
              {item.description ? (
                <p className="mt-0.5 text-sm text-fg-muted">{item.description}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

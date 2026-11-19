import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { humanizeStatus, type StatusKey, statusOf, TONE_ICON, type Tone } from '../lib/status.ts';
import { Badge } from './badge.tsx';

export function resolveStatus(status: string, tone?: Tone, icon?: LucideIcon) {
  const entry = statusOf(status);
  const t = tone ?? entry?.tone ?? 'neutral';
  return {
    entry,
    tone: t,
    Icon: icon ?? entry?.icon ?? TONE_ICON[t],
    label: entry?.label ?? humanizeStatus(status),
    // Running and processing spin while they last, also under reduced motion: they carry state.
    spin: entry?.spin ? 'wl-spin wl-essential' : undefined,
  };
}

/**
 * Icon plus text, never colour alone: the pill without its change ring, so server-rendered pages
 * (no hooks, no DOM) share it. StatusPill adds the ring through `after`.
 */
export function StatusBadge({
  status,
  tone,
  icon,
  children,
  className,
  after,
}: {
  status: StatusKey | (string & {});
  tone?: Tone;
  icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
  after?: ReactNode;
}) {
  const s = resolveStatus(status, tone, icon);
  return (
    <Badge tone={s.tone} className={cn('relative', className)}>
      <s.Icon aria-hidden className={s.spin} />
      {children ?? s.label}
      {after}
    </Badge>
  );
}

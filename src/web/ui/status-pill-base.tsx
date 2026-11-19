import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useChangeCount } from '../lib/change-count.ts';
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

export interface StatusPillProps {
  /** A known status key; unknown keys render neutral with a humanized label. */
  status: StatusKey | (string & {});
  tone?: Tone;
  /** Overrides the vocabulary icon (this_device takes the device's icon). */
  icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
}

/**
 * Icon plus text, never colour alone. Hooks only count renders, so it also renders on the server
 * (/p): the portal, admin and /p share this one pill.
 */
export function StatusPill({ status, tone, icon, children, className }: StatusPillProps) {
  const s = resolveStatus(status, tone, icon);
  const changed = useChangeCount(status);
  return (
    <Badge tone={s.tone} className={cn('relative', className)}>
      <s.Icon aria-hidden className={s.spin} />
      {children ?? s.label}
      {changed ? <span key={changed} aria-hidden className="wl-ring" /> : null}
    </Badge>
  );
}

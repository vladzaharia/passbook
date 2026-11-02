import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { COARSE_ONLY, useMediaQuery } from '../lib/media.ts';
import { useChangeCount } from '../lib/motion.ts';
import { humanizeStatus, type StatusKey, statusOf, TONE_ICON, type Tone } from '../lib/status.ts';
import { Badge } from './badge.tsx';
import { TOUCH_HIT } from './button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';
import { Tooltip } from './tooltip.tsx';

export interface StatusPillProps {
  /** A known status key; unknown keys render neutral with a humanized label. */
  status: StatusKey | (string & {});
  tone?: Tone;
  /** Overrides the vocabulary icon (this_device takes the device's icon). */
  icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg-muted',
  accent: 'text-accent-fg',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

function resolve(status: string, tone?: Tone, icon?: LucideIcon) {
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

/** Icon plus text, never colour alone. */
export function StatusPill({ status, tone, icon, children, className }: StatusPillProps) {
  const s = resolve(status, tone, icon);
  const changed = useChangeCount(status);
  return (
    <Badge tone={s.tone} className={cn('relative', className)}>
      <s.Icon aria-hidden className={s.spin} />
      {children ?? s.label}
      {changed ? <span key={changed} aria-hidden className="wl-ring" /> : null}
    </Badge>
  );
}

/**
 * A state every row would repeat: the icon alone, with the label and hint in a tooltip. Touch has
 * no hover, so there a tap opens the same sentence (44 px hit area around the 16 px icon).
 */
export function StatusIcon({ status, tone, icon, className }: Omit<StatusPillProps, 'children'>) {
  const s = resolve(status, tone, icon);
  const text = s.entry?.hint ? `${s.label}. ${s.entry.hint}` : s.label;
  const touch = useMediaQuery(COARSE_ONLY);
  const trigger = (
    <button
      type="button"
      aria-label={text}
      className={cn(
        'relative inline-flex cursor-default rounded-sm focus-visible:outline-2 focus-visible:outline-focus',
        TOUCH_HIT,
        TONE_TEXT[s.tone],
        className,
      )}
    >
      <s.Icon aria-hidden className={cn('size-4', s.spin)} />
    </button>
  );
  if (!touch) return <Tooltip content={text}>{trigger}</Tooltip>;
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-auto max-w-xs px-2 py-1 text-xs text-fg-strong"
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}

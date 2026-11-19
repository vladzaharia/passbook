import { cn } from '../lib/cn.ts';
import { COARSE_ONLY, useMediaQuery } from '../lib/media.ts';
import type { Tone } from '../lib/status.ts';
import { TOUCH_HIT } from './button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';
import { resolveStatus, StatusPill, type StatusPillProps } from './status-pill-base.tsx';
import { Tooltip } from './tooltip.tsx';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg-muted',
  accent: 'text-accent-fg',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

/**
 * A state every row would repeat: the icon alone, with the label and hint in a tooltip. Touch has
 * no hover, so there a tap opens the same sentence (44 px hit area around the 16 px icon).
 */
export function StatusIcon({ status, tone, icon, className }: Omit<StatusPillProps, 'children'>) {
  const s = resolveStatus(status, tone, icon);
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

export { StatusPill, type StatusPillProps };

import { cn } from '../lib/cn.ts';

const FILL = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
} as const;

export interface ProgressBarProps {
  /** The accessible name: what is being counted ("Passes handled"). */
  label: string;
  value: number;
  max: number;
  /** Read aloud instead of the bare number ("3 of 10 passes"). */
  valueText?: string;
  tone?: keyof typeof FILL;
  className?: string;
}

/**
 * The one progress bar: a 6 px track with a fill that scales on X over the motion tokens (only a
 * transform animates; reduced motion jumps). Broadcast and removal progress both use it.
 */
export function ProgressBar({
  label,
  value,
  max,
  valueText,
  tone = 'accent',
  className,
}: ProgressBarProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken', className)}
    >
      <div
        className={cn(
          'h-full origin-left rounded-full motion-safe:transition-transform motion-safe:duration-(--wl-dur-enter) motion-safe:ease-(--wl-ease-move)',
          FILL[tone],
        )}
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  );
}

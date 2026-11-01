import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { useChangeCount } from '../lib/motion.ts';
import { ActiveIndicator } from './active-indicator.tsx';

export interface SegmentOption<V extends string = string> {
  value: V;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  /** Accessible name of the radiogroup. */
  label: string;
  options: readonly SegmentOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  size?: 'sm' | 'md';
  /** Stretch segments to fill the row. */
  block?: boolean;
  className?: string;
}

/**
 * A radiogroup on a sunken track; the raised thumb (ActiveIndicator, 280 ms spring) slides to the
 * selection. Arrow keys move and select, Home/End jump. The SSR fallback (a radio pair) is styled
 * by .pc-seg in pass-card/stage.css.
 */
export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onValueChange,
  size = 'md',
  block,
  className,
}: SegmentedControlProps<V>) {
  const group = useRef<HTMLDivElement>(null);
  // The selected icon springs in on a change, never on mount.
  const changed = useChangeCount(value);
  const enabled = options.filter((o) => !o.disabled);
  const move = (e: KeyboardEvent) => {
    const at = enabled.findIndex((o) => o.value === value);
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    let next: SegmentOption<V> | undefined;
    if (step) next = enabled[(at + step + enabled.length) % enabled.length];
    if (e.key === 'Home') next = enabled[0];
    if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onValueChange(next.value);
    const target = next.value;
    requestAnimationFrame(() =>
      group.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(target)}"]`)?.focus(),
    );
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      className={cn(
        'relative inline-flex rounded-md border border-border bg-surface-sunken p-0.5',
        block && 'flex w-full',
        className,
      )}
    >
      <ActiveIndicator variant="thumb" />
      {options.map((o) => {
        const checked = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a styled radiogroup with roving focus and a sliding thumb
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={o.value}
            tabIndex={checked ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onValueChange(o.value)}
            className={cn(
              'relative inline-flex items-center justify-center gap-1.5 rounded-[5px] px-3 font-medium wl-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
              'disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4',
              size === 'sm' ? 'min-h-7 text-xs' : 'min-h-8 text-sm',
              'pointer-coarse:min-h-11',
              block && 'flex-1',
              checked ? 'text-fg-strong' : 'text-fg-muted hover:not-disabled:text-fg-strong',
            )}
          >
            {o.icon ? (
              <o.icon
                key={checked ? changed : 'idle'}
                aria-hidden
                className={cn(checked && changed > 0 && 'wl-seg-icon')}
              />
            ) : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

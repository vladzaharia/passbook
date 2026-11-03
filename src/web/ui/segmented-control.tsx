import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { useChangeCount } from '../lib/motion.ts';
import { ActiveIndicator } from './active-indicator.tsx';
// Geometry shared with the SSR side toggle (.pc-seg), so both are one size.
import '../pass-card/stage-seg.css';

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
  /** Stretch segments to fill the row. */
  block?: boolean;
  className?: string;
}

/**
 * A radiogroup on a sunken track; the raised thumb (ActiveIndicator, 280 ms spring) slides to the
 * selection. Arrow keys move and select, Home/End jump. One size: 36 tall with 14 px text, 44 on
 * touch. The geometry lives in pass-card/stage-seg.css (.wl-seg), shared with the SSR fallback (a
 * radio pair, .pc-seg).
 */
export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onValueChange,
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
        'wl-seg relative inline-flex border-border bg-surface-sunken',
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
              'relative inline-flex items-center justify-center gap-1.5 wl-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
              'disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4',
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

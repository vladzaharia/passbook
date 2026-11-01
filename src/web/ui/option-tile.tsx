import type { LucideIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { cn } from '../lib/cn.ts';

export interface OptionTileProps {
  name: string;
  value: string;
  label: ReactNode;
  /** One line. */
  description?: ReactNode;
  icon?: LucideIcon;
  /** A visual in place of the icon (template still, avatar). */
  media?: ReactNode;
  checked: boolean;
  onSelect: (value: string) => void;
  /** Enter or double-click: pick and move on (wizards advance). */
  onCommit?: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A radio card: icon, name and a one-line description; the accent ring marks the choice. Native
 * radios in one name give arrow-key movement; Enter or double-click commits.
 */
export function OptionTile({
  name,
  value,
  label,
  description,
  icon: Icon,
  media,
  checked,
  onSelect,
  onCommit,
  disabled,
  className,
}: OptionTileProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      onDoubleClick={() => !disabled && onCommit?.(value)}
      className={cn(
        'relative flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border bg-surface-raised p-4 wl-colors',
        'hover:border-fg-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
        checked ? 'border-accent shadow-[0_0_0_1px_var(--pk-accent)]' : 'border-border-strong',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSelect(value);
            onCommit?.(value);
          }
        }}
        className="sr-only"
      />
      {media ??
        (Icon ? (
          <span
            aria-hidden
            className={cn(
              'inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken',
              checked ? 'text-accent-fg' : 'text-fg-muted',
            )}
          >
            <Icon className="size-5" />
          </span>
        ) : null)}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-fg-strong">{label}</span>
        {description ? (
          <span className="line-clamp-1 text-xs text-fg-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

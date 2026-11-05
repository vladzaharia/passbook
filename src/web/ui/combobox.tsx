import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { CONTROL, CONTROL_HEIGHT } from './input.tsx';
import type { SelectOption } from './select.tsx';

export interface ComboboxOption extends SelectOption {
  /** Leading visual (avatar, icon), shown in the list and the trigger. */
  icon?: ReactNode;
}

export interface ComboboxProps {
  options: readonly ComboboxOption[];
  value?: string | undefined;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Server search: the list is not filtered locally and `onSearch` receives the query. */
  onSearch?: (query: string) => void;
  /** Shown under the list while a server search runs. */
  loading?: boolean;
  /** Below sm only the icon and chevron show; the name stays in the accessible name. */
  compact?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = 'Select',
  searchPlaceholder = 'Search',
  emptyText = 'No results',
  id,
  disabled,
  className,
  onSearch,
  loading,
  compact,
  'aria-label': label,
  ...aria
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const shown = selected?.label ?? placeholder;
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        // The accessible name contains the visible value (WCAG 2.5.3).
        aria-label={label ? `${label}: ${shown}` : undefined}
        disabled={disabled}
        className={cn(
          CONTROL,
          CONTROL_HEIGHT,
          'flex items-center justify-between gap-2 text-left',
          compact && 'max-sm:gap-1 max-sm:px-2',
          className,
        )}
        {...aria}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.icon}
          <span
            className={cn('truncate', !selected && 'text-fg-subtle', compact && 'max-sm:sr-only')}
          >
            {shown}
          </span>
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={16}
          className="wl-pop origin-(--radix-popover-content-transform-origin) z-50 w-(--radix-popover-trigger-width) min-w-56 rounded-md border border-border bg-surface-overlay shadow-elevation-2"
        >
          <Command shouldFilter={!onSearch}>
            <Command.Input
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              onValueChange={onSearch}
              className="h-9 w-full border-b border-border bg-transparent px-3 text-sm text-fg outline-hidden placeholder:text-fg-subtle pointer-coarse:h-11 pointer-coarse:text-[max(16px,1rem)]"
            />
            <Command.List className="max-h-64 overflow-auto p-1">
              {loading ? null : (
                <Command.Empty className="px-3 py-2 text-sm text-fg-muted">
                  {emptyText}
                </Command.Empty>
              )}
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  disabled={o.disabled}
                  onSelect={() => {
                    onValueChange(o.value);
                    setOpen(false);
                  }}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-fg pointer-coarse:min-h-11 data-[disabled=true]:opacity-50 data-[selected=true]:bg-state-hover-tint data-[selected=true]:text-fg-strong"
                >
                  <Check
                    aria-hidden
                    className={cn(
                      'size-4 shrink-0 text-accent-fg',
                      o.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {o.icon}
                  <span className="min-w-0 truncate">{o.label}</span>
                </Command.Item>
              ))}
              {loading ? (
                <p className="px-3 py-2 text-sm text-fg-muted" role="status">
                  Searching
                </p>
              ) : null}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

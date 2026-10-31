import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn.ts';
import { CONTROL } from './input.tsx';
import type { SelectOption } from './select.tsx';

export interface ComboboxProps {
  options: readonly SelectOption[];
  value?: string | undefined;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
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
  ...aria
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        className={cn(CONTROL, 'flex h-9 items-center justify-between gap-2 text-left', className)}
        {...aria}
      >
        <span className={cn('truncate', !selected && 'text-fg-subtle')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-(--radix-popover-trigger-width) min-w-56 rounded-md border border-border bg-surface-overlay shadow-elevation-2"
        >
          <Command>
            <Command.Input
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-9 w-full border-b border-border bg-transparent px-3 text-sm text-fg outline-hidden placeholder:text-fg-subtle"
            />
            <Command.List className="max-h-64 overflow-auto p-1">
              <Command.Empty className="px-3 py-2 text-sm text-fg-muted">{emptyText}</Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={o.label}
                  keywords={[o.value]}
                  disabled={o.disabled}
                  onSelect={() => {
                    onValueChange(o.value);
                    setOpen(false);
                  }}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-fg data-[disabled=true]:opacity-50 data-[selected=true]:bg-hover data-[selected=true]:text-fg-strong"
                >
                  <Check
                    aria-hidden
                    className={cn('size-4 text-accent-fg', o.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                  {o.label}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

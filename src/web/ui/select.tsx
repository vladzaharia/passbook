import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { CONTROL } from './input.tsx';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: readonly SelectOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** Option values cannot be empty strings (Radix); use a sentinel like "all". */
export function Select({
  options,
  value,
  onValueChange,
  placeholder = 'Select',
  className,
  id,
  name,
  disabled,
  ...rest
}: SelectProps) {
  // An accessible name must contain the visible value (WCAG 2.5.3 label in name).
  const { 'aria-label': label, ...other } = rest;
  const current = options.find((o) => o.value === value)?.label ?? (value ? '' : placeholder);
  const aria = {
    ...other,
    ...(label ? { 'aria-label': current ? `${label}: ${current}` : label } : {}),
  };
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      name={name}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        className={cn(
          CONTROL,
          'flex h-9 items-center justify-between gap-2 whitespace-nowrap text-left',
          className,
        )}
        {...aria}
      >
        <SelectPrimitive.Value placeholder={placeholder} className="block min-w-0 truncate" />
        <SelectPrimitive.Icon className="shrink-0">
          <ChevronDown aria-hidden className="size-4 text-fg-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="wl-pop origin-(--radix-select-content-transform-origin) z-50 max-h-72 min-w-(--radix-select-trigger-width) overflow-auto rounded-md border border-border bg-surface-overlay p-1 shadow-elevation-2"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex min-h-8 cursor-pointer select-none items-center rounded-sm py-1.5 pr-3 pl-8 text-sm text-fg outline-hidden data-disabled:opacity-50 data-highlighted:bg-state-hover-tint data-highlighted:text-fg-strong"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2">
                  <Check aria-hidden className="size-4 text-accent-fg" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

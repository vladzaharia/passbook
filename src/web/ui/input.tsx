import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn.ts';

/**
 * Shared control look: 3:1 border that darkens on hover, the field surface (raised in light,
 * sunken in dark), visible focus ring, danger edge when invalid. Read-only and disabled sink.
 * 16 px text and 44 px height on touch screens, so iOS never zooms.
 */
export const CONTROL = [
  'w-full min-w-0 rounded-md border border-border-strong bg-(--wl-field) px-3 text-sm text-fg',
  'placeholder:text-(--wl-placeholder) wl-colors',
  // Buttons (select and combobox triggers) match :read-only too; only text fields sink.
  'hover:not-disabled:[&:not(:is(input,textarea):read-only)]:border-fg-muted',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:border-border disabled:bg-(--wl-field-disabled) disabled:text-fg/50',
  '[&:is(input,textarea):read-only]:bg-surface-sunken [&:is(input,textarea):read-only]:text-fg-muted',
  'aria-[invalid=true]:border-danger pointer-coarse:text-base',
].join(' ');

/** Single-line control height: 36 px, 44 px on touch. */
export const CONTROL_HEIGHT = 'h-9 pointer-coarse:h-11';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, type = 'text', ref, ...props }: InputProps) {
  return (
    <input ref={ref} type={type} className={cn(CONTROL, CONTROL_HEIGHT, className)} {...props} />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, rows = 4, ref, ...props }: TextareaProps) {
  return <textarea ref={ref} rows={rows} className={cn(CONTROL, 'py-2', className)} {...props} />;
}

import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn.ts';

/** Shared control look: 3:1 border, sunken well, visible focus ring, danger edge when invalid. */
export const CONTROL = [
  'w-full min-w-0 rounded-md border border-border-strong bg-surface-sunken px-3 text-sm text-fg',
  'placeholder:text-fg-subtle transition-colors duration-150',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:opacity-50 read-only:text-fg-muted',
  'aria-[invalid=true]:border-danger',
].join(' ');

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, type = 'text', ref, ...props }: InputProps) {
  return <input ref={ref} type={type} className={cn(CONTROL, 'h-9', className)} {...props} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, rows = 4, ref, ...props }: TextareaProps) {
  return <textarea ref={ref} rows={rows} className={cn(CONTROL, 'py-2', className)} {...props} />;
}

import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** A key cap hinting a keyboard shortcut. Hidden on touch, where there is no keyboard to press it. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      aria-hidden
      className={cn(
        'rounded-sm border border-border px-1 font-sans pointer-coarse:hidden',
        className,
      )}
      {...props}
    />
  );
}

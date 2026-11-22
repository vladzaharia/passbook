import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        // The button is 44 tall on touch; the 44 x 24 track is drawn inside it.
        'group relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-[3px] pointer-coarse:h-11',
        'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 left-0 h-6 w-11 -translate-y-1/2 rounded-full border border-border-strong bg-surface-sunken transition-[background-color,border-color] duration-(--wl-dur-hover)',
          'group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-focus',
          'group-data-[state=checked]:border-state-checked-edge group-data-[state=checked]:bg-state-checked-fill',
        )}
      />
      {/* Pressed, the thumb stretches toward where it will go. */}
      <SwitchPrimitive.Thumb className="relative block size-4 origin-left rounded-full bg-fg-muted transition-[translate,scale,background-color] duration-(--wl-dur-enter) ease-(--wl-ease-spring) data-[state=checked]:origin-right data-[state=checked]:translate-x-5 data-[state=checked]:bg-state-checked-on motion-safe:group-enabled:group-active:scale-x-125" />
    </SwitchPrimitive.Root>
  );
}

import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';
import { TOUCH_HIT } from './button.tsx';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'group relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border-strong bg-surface-sunken p-[3px] transition-[background-color,border-color] duration-(--wl-dur-hover)',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'data-[state=checked]:border-state-checked-edge data-[state=checked]:bg-state-checked-fill',
        'disabled:cursor-not-allowed disabled:opacity-50',
        TOUCH_HIT,
        className,
      )}
      {...props}
    >
      {/* Pressed, the thumb stretches toward where it will go. */}
      <SwitchPrimitive.Thumb className="block size-4 origin-left rounded-full bg-fg-muted transition-[translate,scale,background-color] duration-(--wl-dur-enter) ease-(--wl-ease-spring) data-[state=checked]:origin-right data-[state=checked]:translate-x-5 data-[state=checked]:bg-state-checked-on motion-safe:group-enabled:group-active:scale-x-125" />
    </SwitchPrimitive.Root>
  );
}

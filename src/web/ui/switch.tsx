import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border-strong bg-surface-sunken p-0.5 transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'data-[state=checked]:border-state-checked-edge data-[state=checked]:bg-state-checked-fill',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4.5 rounded-full bg-fg-muted transition-[translate,background-color] duration-(--wl-dur-enter) ease-(--wl-ease-spring) data-[state=checked]:translate-x-5 data-[state=checked]:bg-state-checked-on" />
    </SwitchPrimitive.Root>
  );
}

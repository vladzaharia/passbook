import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn.ts';
import type { TooltipConfig, TooltipProps } from './tooltip.tsx';

/** Radix and floating-ui weigh ~19 kB gzip; tooltip.tsx loads this file after first paint. */
export function TooltipImpl({
  content,
  children,
  side = 'top',
  className,
  config,
}: TooltipProps & { config: TooltipConfig }) {
  return (
    <TooltipPrimitive.Provider {...config}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className={cn(
              'wl-tip z-50 max-w-xs rounded-md border border-border bg-surface-overlay px-2 py-1 text-xs text-fg-strong shadow-elevation-2',
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

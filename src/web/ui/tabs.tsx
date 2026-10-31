import * as Primitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        'relative -mb-px min-h-9 shrink-0 border-b-2 border-transparent px-3 text-sm text-fg-muted transition-colors',
        'hover:text-fg-strong data-[state=active]:border-accent data-[state=active]:text-fg-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content
      className={cn('pt-4 focus-visible:outline-2 focus-visible:outline-focus', className)}
      {...props}
    />
  );
}

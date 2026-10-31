import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { DialogOverlay } from './dialog.tsx';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps
  extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  side?: 'left' | 'right';
  hideTitle?: boolean;
}

export function SheetContent({
  title,
  side = 'right',
  hideTitle,
  className,
  children,
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-y-0 z-50 flex w-72 max-w-[85vw] flex-col border-border bg-surface-raised shadow-elevation-3',
          side === 'left'
            ? 'left-0 border-r data-[state=open]:animate-[wallet-slide-left_200ms_ease-out]'
            : 'right-0 border-l data-[state=open]:animate-[wallet-slide-right_200ms_ease-out]',
          className,
        )}
        {...props}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <DialogPrimitive.Title
            className={cn('text-sm font-semibold text-fg-strong', hideTitle && 'sr-only')}
          >
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label="Close"
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

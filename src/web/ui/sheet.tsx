import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';
import { cn } from '../lib/cn.ts';
import { DialogOverlay, restoreOpener, useOpener } from './dialog.tsx';

const SheetOpener = createContext<{ current: HTMLElement | null } | null>(null);

export function Sheet(props: ComponentProps<typeof DialogPrimitive.Root>) {
  const opener = useOpener(props.open);
  return (
    <SheetOpener.Provider value={opener}>
      <DialogPrimitive.Root {...props} />
    </SheetOpener.Provider>
  );
}
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
  onCloseAutoFocus,
  ...props
}: SheetContentProps) {
  const opener = useContext(SheetOpener);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (!e.defaultPrevented) restoreOpener(opener)(e);
        }}
        className={cn(
          'fixed inset-y-0 z-50 flex w-72 max-w-[calc(100%-1rem)] flex-col border-border bg-surface-raised shadow-elevation-3',
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
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-state-hover-tint hover:text-fg-strong"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

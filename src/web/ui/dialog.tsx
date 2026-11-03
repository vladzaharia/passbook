import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ComponentProps, createContext, type ReactNode, useContext, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { DiscardDialog } from './alert-dialog.tsx';
import {
  DIALOG_ACTIONS,
  DIALOG_PANEL,
  DialogOverlay,
  focusInitial,
  OVERLAY_TITLE,
  restoreOpener,
  useOpener,
} from './overlay.tsx';

const OpenerContext = createContext<{ current: HTMLElement | null } | null>(null);

export interface DialogProps extends ComponentProps<typeof DialogPrimitive.Root> {
  /**
   * The form holds unsaved input: Esc, an outside click and the X ask "Discard unsaved changes?"
   * before closing. Cancel in the footer closes at once (it is the discard).
   */
  dirty?: boolean;
}

/** Dialog root. Focus returns to the opener on close, with or without a DialogTrigger. */
export function Dialog({ dirty, onOpenChange, ...props }: DialogProps) {
  const opener = useOpener(props.open);
  const [asking, setAsking] = useState(false);
  const change = (open: boolean) => {
    if (!open && dirty) setAsking(true);
    else onOpenChange?.(open);
  };
  return (
    <OpenerContext.Provider value={opener}>
      <DialogPrimitive.Root onOpenChange={change} {...props} />
      <DiscardDialog
        open={asking && props.open !== false}
        onOpenChange={setAsking}
        onDiscard={() => onOpenChange?.(false)}
      />
    </OpenerContext.Provider>
  );
}
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps
  extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** Visually hide the title; it stays the accessible name. */
  hideTitle?: boolean;
  /** sm 384 confirms, md 512 forms (default), lg 768 uploads and editors. */
  size?: 'sm' | 'md' | 'lg';
  /** Destructive confirms have no X. */
  closeButton?: boolean;
}

const SIZES = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-3xl' } as const;

export function DialogContent({
  title,
  description,
  footer,
  hideTitle,
  size = 'md',
  closeButton = true,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  const opener = useContext(OpenerContext);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        {...(description ? {} : { 'aria-describedby': undefined })}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (!e.defaultPrevented) focusInitial(e);
        }}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (!e.defaultPrevented) restoreOpener(opener)(e);
        }}
        className={cn(DIALOG_PANEL, SIZES[size], 'outline-none', className)}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className={cn(OVERLAY_TITLE, hideTitle && 'sr-only')}>
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 max-w-[65ch] text-sm text-fg-muted">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          {closeButton ? (
            <DialogPrimitive.Close
              aria-label="Close"
              className="relative -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong pointer-coarse:size-11"
            >
              <X aria-hidden className="size-4" />
            </DialogPrimitive.Close>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className={cn(DIALOG_ACTIONS, 'border-t border-border px-5 py-3')}>{footer}</div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

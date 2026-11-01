import * as DialogPrimitive from '@radix-ui/react-dialog';
import { type ReactNode, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/errors.ts';
import { Button } from './button.tsx';
import { DialogOverlay, restoreOpener, useOpener } from './dialog.tsx';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** May be async; the dialog stays open and shows loading until it settles. */
  onConfirm: () => void | Promise<void>;
}

/** In-app confirmation. Never use window.confirm. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useOpener(open);

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      // Stay open so the user can retry or cancel.
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          role="alertdialog"
          // The safe choice gets focus first.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={restoreOpener(opener)}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface-overlay p-5 shadow-elevation-3',
          )}
        >
          <DialogPrimitive.Title className="text-base font-semibold text-fg-strong">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-2 text-sm text-fg-muted">
              {description}
            </DialogPrimitive.Description>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              ref={cancelRef}
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button variant={destructive ? 'danger' : 'primary'} loading={busy} onClick={confirm}>
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

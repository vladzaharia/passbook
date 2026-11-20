import { type ReactNode, useState } from 'react';
import { errorMessage } from '../../../lib/errors.ts';
import { Button, Dialog, DialogContent } from '../../../ui/index.ts';

/**
 * A confirm that carries a form control (the "Also issue new codes" box), which ConfirmDialog's
 * paragraph body cannot hold. Stays open with the error when the save fails.
 */
export function ReviewDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  disabled,
  lines,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  confirmLabel: string;
  disabled?: boolean;
  lines: readonly string[];
  children?: ReactNode;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="sm"
        title={title}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={disabled} onClick={() => void confirm()}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-fg-muted">
          <ul className="flex flex-col gap-1">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {children}
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { type ReactNode, useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors.ts';
import { Button, Dialog, DialogContent, FormField, Input } from '../../ui/index.ts';

/** Destructive confirmation that needs the exact word typed. Stays open on failure. */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  word,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  word: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) {
      setTyped('');
      setError(undefined);
    }
  }, [open]);

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
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={typed !== word} onClick={confirm}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <FormField label={`Type ${word} to confirm`} error={error}>
          {(c) => (
            <Input
              {...c}
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed === word && !busy) void confirm();
              }}
            />
          )}
        </FormField>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from 'react';
import { REMOVE_MESSAGE_MAX } from '@/shared/contracts/events.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { Button, Dialog, DialogContent, FormField, Textarea } from '../../../ui/index.ts';

/**
 * Remove from Wallet. Apple has no call that deletes a pass from a device, so the copy states what
 * happens: the pass moves to Expired passes and the holder deletes it there.
 */
export function RemoveDialog({
  open,
  onOpenChange,
  count = 1,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count?: number;
  onConfirm: (message: string | undefined) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const many = count > 1;

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(message.trim() || undefined);
      setMessage('');
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)} dirty={message !== ''}>
      <DialogContent
        size="md"
        closeButton={false}
        title={many ? `Remove ${count} passes from Wallet?` : 'Remove from Wallet?'}
        description={
          many
            ? 'Each pass moves to Expired passes in Wallet, and its holder can delete it there.'
            : 'The pass moves to Expired passes in Wallet, and the holder can delete it there.'
        }
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void submit()}>
              Remove
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormField
            label="Message for holders (optional)"
            error={error}
            help="Added to the pass back. Wallet may also show it as a notification."
          >
            {(c) => (
              <Textarea
                {...c}
                rows={3}
                maxLength={REMOVE_MESSAGE_MAX}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            )}
          </FormField>
        </form>
      </DialogContent>
    </Dialog>
  );
}

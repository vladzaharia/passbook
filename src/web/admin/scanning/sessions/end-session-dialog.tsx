import { useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, Callout, Dialog, DialogContent, SwitchRow } from '@/web/ui/index.ts';
import { useUpdateSession } from './api.ts';

/** End stops check-ins; Remove its devices, on by default, revokes every device in the same write. */
export function EndSessionDialog({
  session: s,
  onClose,
}: {
  session: ScanningSession;
  onClose: () => void;
}) {
  const update = useUpdateSession(s.id);
  const [remove, setRemove] = useState(true);
  const [error, setError] = useState('');
  async function end() {
    setError('');
    try {
      await update.mutateAsync({
        status: 'ended',
        ...(remove ? { removeDevices: true } : {}),
        revision: s.updatedAt,
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !update.isPending && onClose()}>
      <DialogContent
        title="End session?"
        size="sm"
        footer={
          <>
            <Button variant="outline" disabled={update.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" loading={update.isPending} onClick={() => void end()}>
              End session
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <p className="text-sm text-fg-muted tabular-nums">
            {s.today} done today · {s.deviceCount} {s.deviceCount === 1 ? 'device' : 'devices'}
          </p>
          <SwitchRow label="Remove its devices" checked={remove} onCheckedChange={setRemove} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

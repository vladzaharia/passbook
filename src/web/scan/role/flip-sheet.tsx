import { useState } from 'react';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanApi } from '../api/scan-api.ts';

/** Show to customer: this phone becomes the customer screen; the server holds the change. */
export function FlipSheet({
  open,
  api,
  refetch,
  onClose,
}: {
  open: boolean;
  api: ScanApi;
  refetch: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function flip() {
    setBusy(true);
    setError('');
    try {
      await api.setRole({ role: 'customer' });
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <SheetContent title="Show to customer?" className="scan-detail-sheet">
        <div className="flex flex-col gap-4 p-5">
          <p className="text-sm text-fg-muted">Scanning stops until staff switch back.</p>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button loading={busy} onClick={() => void flip()}>
            Show to customer
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanApi } from '../api/scan-api.ts';

const HOLD_MS = 2000;

/**
 * Back to scanning, on the customer face. Hold to ask; the server answers with a PIN request when
 * the org has staff. Nothing here decides: the role changes only when the server says so.
 */
export function RoleUnlock({ api, refetch }: { api: ScanApi; refetch: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = useCallback(() => clearTimeout(timer.current), []);
  useEffect(() => stop, [stop]);
  async function back() {
    setError('');
    try {
      await api.setRole({ role: 'scan' });
      await refetch();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'UNLOCK_REQUIRED') setAsking(true);
      else setError(errorMessage(cause));
    }
  }
  const start = () => {
    stop();
    timer.current = setTimeout(() => void back(), HOLD_MS);
  };
  return (
    <>
      <div className="fixed left-3 bottom-3 z-10 flex flex-col items-start gap-2">
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <Button
          variant="ghost"
          size="sm"
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onKeyDown={(e) => e.key === 'Enter' && !e.repeat && start()}
          onKeyUp={stop}
        >
          Hold to switch back
        </Button>
      </div>
      <UnlockSheet open={asking} api={api} refetch={refetch} onClose={() => setAsking(false)} />
    </>
  );
}

function UnlockSheet({
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
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.setRole({ role: 'scan', unlock: { pin } });
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause));
      setPin('');
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <SheetContent title="Back to scanning?" className="scan-detail-sheet">
        <form
          className="grid gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormField label="Staff PIN">
            {(p) => <CodeField id={p.id} value={pin} onChange={setPin} disabled={busy} />}
          </FormField>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button type="submit" disabled={pin.length !== 6} loading={busy}>
            Switch back
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

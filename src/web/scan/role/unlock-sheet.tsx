import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebounced } from '../../lib/debounce.ts';
import { ApiError, errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { ScanTextField } from '../input/wedge-field.tsx';

const HOLD_MS = 2000;
type Person = { id: string; name: string };

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
      <div className="fixed right-3 bottom-3 z-10 flex flex-col items-end gap-2">
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
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const [found, setFound] = useState<Person[]>([]);
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seen = useRef(new Map<string, Person>());
  useEffect(() => {
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    api
      .roleStaff(q)
      .then((result) => live && setFound(result.items))
      .catch((cause) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, [q, api]);
  for (const person of found) seen.current.set(person.id, person);
  const chosen = seen.current.get(staffId);
  const people = chosen && !found.some((p) => p.id === staffId) ? [chosen, ...found] : found;
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.setRole({ role: 'scan', unlock: { staffId, pin } });
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
          <FormField label="Find your name">
            {(p) => <ScanTextField {...p} value={text} onChange={(e) => setText(e.target.value)} />}
          </FormField>
          <FormField label="Staff member">
            {(p) => (
              <Select
                {...p}
                value={staffId || undefined}
                onValueChange={setStaffId}
                options={people.map((s) => ({ value: s.id, label: s.name }))}
              />
            )}
          </FormField>
          <FormField label="PIN">
            {(p) => <CodeField id={p.id} value={pin} onChange={setPin} disabled={busy} />}
          </FormField>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button type="submit" disabled={!staffId || pin.length !== 6} loading={busy}>
            Switch back
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

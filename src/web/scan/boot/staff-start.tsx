import { useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_STAFF_COPY as COPY } from '../../../shared/copy/scan-staff.ts';
import { useDebounced } from '../../lib/debounce.ts';
import { ApiError, errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import { ScanApiError } from '../api/errors.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { ScanTextField } from '../input/wedge-field.tsx';
import { BootCard } from '../ui/boot-card.tsx';
import { StaffPinPad } from './staff-pin-pad.tsx';

// Fallback only: the server's 429 carries Retry-After (staff-pin.ts lockedError), which wins.
const LOCK_MS = 60_000;

function lockMsOf(cause: ApiError): number {
  const ms = cause instanceof ScanApiError ? cause.retryAfterMs : undefined;
  const wait = ms ?? (cause.retryAfter === undefined ? undefined : cause.retryAfter * 1000);
  return wait === undefined ? LOCK_MS : Math.max(1000, wait);
}

type Person = NonNullable<ScanSession['staffList']>[number];

/** "1 tries left" reads wrong, and a lockout needs a next step. */
export const pinMessage = (text: string) =>
  text
    .replace(/\b1 tries left/, '1 try left')
    .replace(
      /(Wrong PIN|Too many wrong PINs)\. Try again later\.$/,
      '$1. Wait a few minutes, or ask a manager.',
    );

export function StaffStart({
  session,
  api,
  refetch,
  initialByName = false,
}: {
  session: ScanSession;
  api: ScanApi;
  refetch: () => Promise<void>;
  /** Opens on the name list (the gallery). */
  initialByName?: boolean;
}) {
  // The PIN alone first; a name is asked for on request, or when the server says the PIN is shared.
  const [byName, setByName] = useState(initialByName);
  const [refusals, setRefusals] = useState(0);
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [locked, setLocked] = useState<number | null>(null);
  // A cut roster: the list holds the first people only, so a name is looked up on the server.
  const truncated = session.staffTruncated === true;
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const [found, setFound] = useState<Person[] | null>(null);
  const seen = useRef(new Map<string, Person>());
  useEffect(() => {
    if (!truncated || !q) {
      setFound(null);
      return;
    }
    let live = true;
    api
      .staffSearch(q)
      .then((result) => live && setFound(result.items))
      .catch((cause) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, [truncated, q, api]);
  const listed = found ?? session.staffList ?? [];
  for (const person of listed) seen.current.set(person.id, person);
  const chosen = seen.current.get(staffId);
  const people = chosen && !listed.some((p) => p.id === staffId) ? [chosen, ...listed] : listed;
  // The lockout is the server's; the keys come back after its Retry-After and the server decides again.
  useEffect(() => {
    if (locked === null) return;
    const id = setTimeout(() => setLocked(null), locked);
    return () => clearTimeout(id);
  }, [locked]);
  async function submit(digits: string, named: boolean) {
    setBusy(true);
    setError('');
    try {
      await api.staffSignIn(named ? { staffId, pin: digits } : { pin: digits });
      await refetch();
    } catch (cause) {
      setError(pinMessage(errorMessage(cause)));
      setRefusals((n) => n + 1);
      setPin('');
      if (cause instanceof ApiError && cause.code === 'RATE_LIMITED') setLocked(lockMsOf(cause));
      if (!named && cause instanceof ApiError && cause.code === 'STAFF_NAME_REQUIRED')
        setByName(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <BootCard title={COPY.title} line={session.workspace?.session.name ?? session.scanner?.name}>
      {byName ? (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(pin, true);
          }}
        >
          {truncated ? (
            <FormField label="Find your name">
              {(p) => (
                <ScanTextField {...p} value={text} onChange={(e) => setText(e.target.value)} />
              )}
            </FormField>
          ) : null}
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
          {truncated && q && found?.length === 0 ? (
            <p className="text-sm text-fg-muted">No one by that name.</p>
          ) : null}
          <FormField label="PIN">
            {(p) => (
              <CodeField
                id={p.id}
                value={pin}
                onChange={setPin}
                disabled={busy || locked !== null}
              />
            )}
          </FormField>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {!people.length && !truncated ? (
            <Callout tone="warning">
              Add staff in the administration panel to use this session.
            </Callout>
          ) : null}
          <Button
            type="submit"
            disabled={locked !== null || !staffId || pin.length !== 6}
            loading={busy}
          >
            Sign in
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setByName(false)}>
            {COPY.usePin}
          </Button>
        </form>
      ) : (
        <StaffPinPad
          busy={busy}
          locked={locked !== null}
          error={error}
          shake={refusals}
          onPin={(digits) => void submit(digits, false)}
          onName={() => {
            setError('');
            setByName(true);
          }}
        />
      )}
    </BootCard>
  );
}

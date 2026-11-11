import { useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { useDebounced } from '../../lib/debounce.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { ScanTextField } from '../input/wedge-field.tsx';
import { BootCard } from '../ui/boot-card.tsx';

type Person = NonNullable<ScanSession['staffList']>[number];

export function StaffStart({
  session,
  api,
  refetch,
}: {
  session: ScanSession;
  api: ScanApi;
  refetch: () => Promise<void>;
}) {
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.staffSignIn({ staffId, pin });
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause));
      setPin('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <BootCard title="Staff sign-in" line={session.workspace?.session.name ?? session.scanner?.name}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {truncated ? (
          <FormField label="Find your name">
            {(p) => <ScanTextField {...p} value={text} onChange={(e) => setText(e.target.value)} />}
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
          {(p) => <CodeField id={p.id} value={pin} onChange={setPin} disabled={busy} />}
        </FormField>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {!people.length && !truncated ? (
          <Callout tone="warning">
            Add staff in the administration panel to use this session.
          </Callout>
        ) : null}
        <Button type="submit" disabled={!staffId || pin.length !== 6} loading={busy}>
          Sign in
        </Button>
      </form>
    </BootCard>
  );
}

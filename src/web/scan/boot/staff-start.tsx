import { useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { CodeField } from '../../ui/code-field.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { BootCard } from '../ui/boot-card.tsx';

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
        <FormField label="Staff member">
          {(p) => (
            <Select
              {...p}
              value={staffId || undefined}
              onValueChange={setStaffId}
              options={(session.staffList ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          )}
        </FormField>
        <FormField label="PIN">
          {(p) => <CodeField id={p.id} value={pin} onChange={setPin} disabled={busy} />}
        </FormField>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {!session.staffList?.length ? (
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

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { OrgListSchema } from '../../../shared/contracts/orgs.ts';
import type { ScanAdminScopeSchema } from '../../../shared/contracts/scan.ts';
import { AdminScannerStartedSchema } from '../../../shared/contracts/scan-setups.ts';
import { SessionResponseSchema } from '../../../shared/contracts/session.ts';
import { api } from '../../lib/api.ts';
import { errorMessage } from '../../lib/errors.ts';
import { localZone } from '../../lib/timezones.ts';
import { Button } from '../../ui/button.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import { BootCard } from '../ui/boot-card.tsx';

export function AdminStart({
  onScope,
  onCancel,
}: {
  onScope: (scope: z.infer<typeof ScanAdminScopeSchema>) => void;
  onCancel?: () => void;
}) {
  const [orgId, setOrgId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const orgs = useQuery({
    queryKey: ['scan', 'admin-orgs'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs', OrgListSchema, { query: { limit: 100 }, signal }),
  });
  async function start() {
    setBusy(true);
    setFailed(undefined);
    try {
      const session = await api.get('/api/v1/session', SessionResponseSchema);
      if (!session.authenticated || !session.roles.includes('admin')) {
        location.assign('/login?next=%2Fscan%3Fadmin%3D1');
        return;
      }
      const setup = await api.post(
        '/api/v1/scan-setups/admin-session',
        AdminScannerStartedSchema,
        { orgId, timeZone: localZone() },
        { headers: { 'x-csrf-token': session.csrfToken } },
      );
      onScope(setup);
    } catch (error) {
      setFailed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <BootCard title="Scan as Admin" line="Use your managed scanner setup for this organization.">
      <FormField label="Organization">
        {(p) => (
          <Select
            {...p}
            value={orgId}
            onValueChange={setOrgId}
            options={orgs.data?.items.map((o) => ({ value: o.id, label: o.name })) ?? []}
          />
        )}
      </FormField>
      {failed || orgs.error ? <p role="alert">{failed ?? errorMessage(orgs.error)}</p> : null}
      <Button disabled={!orgId} loading={busy} onClick={() => void start()}>
        Start admin session
      </Button>
      {onCancel ? (
        <Button variant="outline" onClick={onCancel}>
          Use pairing code
        </Button>
      ) : null}
    </BootCard>
  );
}

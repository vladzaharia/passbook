import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { OrgListSchema } from '../../../shared/contracts/orgs.ts';
import type { ScanAdminScopeSchema } from '../../../shared/contracts/scan.ts';
import { AdminScannerStartedSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { SessionResponseSchema } from '../../../shared/contracts/session.ts';
import { api } from '../../lib/api.ts';
import { errorMessage } from '../../lib/errors.ts';
import { localZone } from '../../lib/timezones.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { FormField } from '../../ui/field.tsx';
import { Select } from '../../ui/select.tsx';
import { ScanTextField } from '../input/wedge-field.tsx';
import { BootCard } from '../ui/boot-card.tsx';
import { scanDeviceKey } from './device-key.ts';

export function AdminStart({
  onScope,
  onCancel,
}: {
  onScope: (scope: z.infer<typeof ScanAdminScopeSchema>) => void;
  onCancel?: () => void;
}) {
  const params = new URLSearchParams(location.search);
  const [orgId, setOrgId] = useState(params.get('orgId') ?? '');
  const [sessionId, setSessionId] = useState(params.get('sessionId') ?? '');
  const [name, setName] = useState('Front desk');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const orgs = useQuery({
    queryKey: ['scan', 'admin-orgs'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs', OrgListSchema, { query: { limit: 100 }, signal }),
  });
  const org = orgId || (orgs.data?.items.length === 1 ? (orgs.data.items[0]?.id ?? '') : '');
  const sessions = useQuery({
    queryKey: ['scan', 'admin-sessions', org],
    enabled: !!org,
    queryFn: ({ signal }) =>
      api.get('/api/v1/scanning-sessions', ScanningSessionListSchema, {
        query: { orgId: org, limit: 100 },
        signal,
      }),
  });
  const selected = useQuery({
    queryKey: ['scan', 'admin-selected-session', params.get('sessionId')],
    enabled: !!params.get('sessionId'),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/scanning-sessions/${encodeURIComponent(params.get('sessionId') ?? '')}`,
        ScanningSessionDetailSchema,
        { signal },
      ),
  });
  const options = [...(sessions.data?.items ?? [])];
  if (
    selected.data &&
    selected.data.orgId === org &&
    !options.some((s) => s.id === selected.data?.id)
  )
    options.unshift(selected.data);
  const active = options.filter((s) => s.status === 'active') ?? [];
  const chosen = active.some((s) => s.id === sessionId)
    ? sessionId
    : !sessionId && active.length === 1
      ? (active[0]?.id ?? '')
      : '';
  const creating = sessions.isSuccess && !selected.isFetching && active.length === 0;
  async function start() {
    if (!org || (!chosen && !creating)) return;
    setBusy(true);
    setFailed('');
    try {
      const identity = await api.get('/api/v1/session', SessionResponseSchema);
      if (!identity.authenticated || !identity.roles.includes('admin')) {
        setFailed('Sign in as an administrator to continue.');
        return;
      }
      const headers = { 'x-csrf-token': identity.csrfToken };
      const id =
        chosen ||
        (
          await api.post(
            '/api/v1/scanning-sessions',
            ScanningSessionDetailSchema,
            { orgId: org, name: name.trim(), timeZone: localZone() },
            { headers },
          )
        ).id;
      const joined = await api.post(
        '/api/v1/scanning-sessions/join',
        AdminScannerStartedSchema,
        { sessionId: id, deviceKey: scanDeviceKey() },
        { headers },
      );
      onScope(joined);
    } catch (error) {
      setFailed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <BootCard title="Scan as Admin" line="Join a scanning session with your administrator sign-in.">
      <FormField label="Organization">
        {(p) => (
          <Select
            {...p}
            value={org || undefined}
            onValueChange={(id) => {
              setOrgId(id);
              if (id !== org) setSessionId('');
            }}
            options={orgs.data?.items.map((o) => ({ value: o.id, label: o.name })) ?? []}
          />
        )}
      </FormField>
      {org && !creating ? (
        <FormField label="Scanning session" help="This device uses the session’s shared rules.">
          {(p) => (
            <Select
              {...p}
              value={chosen || undefined}
              onValueChange={setSessionId}
              options={active.map((s) => ({ value: s.id, label: s.name }))}
              placeholder={sessions.isPending ? 'Loading sessions…' : 'Choose a session'}
            />
          )}
        </FormField>
      ) : null}
      {creating ? (
        <FormField label="New session name" help="No active sessions here yet.">
          {(p) => (
            <ScanTextField
              {...p}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          )}
        </FormField>
      ) : null}
      {failed || orgs.error || sessions.error ? (
        <Callout tone="danger">{failed || errorMessage(orgs.error ?? sessions.error)}</Callout>
      ) : null}
      <Button
        disabled={!org || (!chosen && (!creating || !name.trim()))}
        loading={busy}
        onClick={() => void start()}
      >
        {creating ? 'Create and join' : 'Join session'}
      </Button>
      {onCancel ? (
        <Button variant="ghost" onClick={onCancel}>
          Use pairing code
        </Button>
      ) : null}
    </BootCard>
  );
}

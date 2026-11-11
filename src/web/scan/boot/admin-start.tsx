import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { OrgMembershipListSchema } from '../../../shared/contracts/org-membership.ts';
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

interface AdminStartProps {
  userId: string;
  onScope: (scope: z.infer<typeof ScanAdminScopeSchema>) => void;
  onCancel?: () => void;
}

/** A different authenticated user must explicitly choose an organization again. */
export function AdminStart(props: AdminStartProps) {
  return <AdminStartForUser key={props.userId} {...props} />;
}

function AdminStartForUser({ userId, onScope, onCancel }: AdminStartProps) {
  const params = new URLSearchParams(location.search);
  const [selection, setSelection] = useState<{ membershipId: string; orgId: string } | null>(null);
  const [sessionId, setSessionId] = useState(params.get('sessionId') ?? '');
  const [name, setName] = useState('Front desk');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const orgs = useQuery({
    queryKey: ['scan', 'admin-orgs', userId],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs/memberships/me', OrgMembershipListSchema, { signal }),
  });
  useEffect(() => {
    if (!selection || orgs.isFetching || (!orgs.isSuccess && !orgs.isError)) return;
    if (
      orgs.isSuccess &&
      orgs.data.items.some(
        (membership) =>
          membership.id === selection.membershipId &&
          membership.orgId === selection.orgId &&
          membership.userId === userId &&
          membership.revokedAt === null &&
          membership.capabilities.includes('scanning:manage'),
      )
    )
      return;
    if (pending.current) {
      pending.current.abort();
      pending.current = null;
      setBusy(false);
      setFailed('Your scanning access changed. Choose an organization again.');
    }
    setSelection(null);
    setSessionId('');
  }, [selection, orgs.data, orgs.isFetching, orgs.isSuccess, orgs.isError, userId]);
  const loadingOrgs = orgs.isPending || orgs.isFetching;
  const memberships =
    orgs.isSuccess && !orgs.isFetching
      ? orgs.data.items.filter(
          (membership) =>
            membership.userId === userId &&
            membership.revokedAt === null &&
            membership.capabilities.includes('scanning:manage'),
        )
      : [];
  const selectedMembership = memberships.find(
    (membership) =>
      selection !== null &&
      membership.id === selection.membershipId &&
      membership.orgId === selection.orgId,
  );
  const org = selectedMembership?.orgId ?? '';
  const sessions = useQuery({
    queryKey: ['scan', 'admin-sessions', userId, org],
    enabled: !!org,
    queryFn: ({ signal }) =>
      api.get('/api/v1/scanning-sessions', ScanningSessionListSchema, {
        query: { orgId: org, limit: 100 },
        signal,
      }),
  });
  const requestedSessionId =
    sessionId === params.get('sessionId') && (!params.get('orgId') || params.get('orgId') === org)
      ? sessionId
      : '';
  const selected = useQuery({
    queryKey: ['scan', 'admin-selected-session', userId, org, requestedSessionId],
    enabled: !!org && !!requestedSessionId,
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/scanning-sessions/${encodeURIComponent(requestedSessionId)}`,
        ScanningSessionDetailSchema,
        { signal },
      ),
  });
  const options =
    sessions.isSuccess && !sessions.isFetching
      ? sessions.data.items.filter((item) => item.orgId === org)
      : [];
  if (
    !selected.isFetching &&
    !selected.isError &&
    selected.data &&
    selected.data.orgId === org &&
    !options.some((s) => s.id === selected.data?.id)
  )
    options.unshift(selected.data);
  const active = options.filter((item) => item.status === 'active');
  const chosen = active.some((s) => s.id === sessionId)
    ? sessionId
    : !sessionId && active.length === 1
      ? (active[0]?.id ?? '')
      : '';
  const creating =
    sessions.isSuccess &&
    !sessions.isFetching &&
    !selected.isFetching &&
    !selected.isError &&
    active.length === 0 &&
    (!sessionId || (selected.isSuccess && selected.data.orgId === org));
  async function start() {
    if (
      pending.current ||
      !org ||
      sessions.isFetching ||
      sessions.isError ||
      selected.isFetching ||
      selected.isError ||
      (!chosen && !creating)
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailed('');
    try {
      const identity = await api.get('/api/v1/session', SessionResponseSchema, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!identity.authenticated || identity.user.id !== userId) {
        setFailed('Your sign-in changed. Reopen the scanner and try again.');
        return;
      }
      const refreshed = await orgs.refetch();
      if (controller.signal.aborted) return;
      if (
        refreshed.isError ||
        !refreshed.data?.items.some(
          (membership) =>
            membership.id === selection?.membershipId &&
            membership.userId === userId &&
            membership.orgId === org &&
            membership.revokedAt === null &&
            membership.capabilities.includes('scanning:manage'),
        )
      ) {
        setSelection(null);
        setSessionId('');
        setFailed('Your scanning access changed. Choose an organization again.');
        return;
      }
      const headers = { 'x-csrf-token': identity.csrfToken };
      let id = chosen;
      if (!id) {
        const created = await api.post(
          '/api/v1/scanning-sessions',
          ScanningSessionDetailSchema,
          { orgId: org, name: name.trim(), timeZone: localZone() },
          { headers, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (created.orgId !== org) {
          setFailed('The session belongs to a different organization. Try again.');
          return;
        }
        id = created.id;
      }
      const joined = await api.post(
        '/api/v1/scanning-sessions/join',
        AdminScannerStartedSchema,
        { sessionId: id, deviceKey: scanDeviceKey() },
        { headers, signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (joined.orgId !== org) {
        setFailed('The scanner belongs to a different organization. Try again.');
        return;
      }
      onScope(joined);
    } catch (error) {
      if (!controller.signal.aborted) setFailed(errorMessage(error));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <BootCard title="Scan as Admin" line="Join a scanning session with your account.">
      {loadingOrgs || orgs.isError || memberships.length > 0 ? (
        <FormField label="Organization">
          {(p) => (
            <Select
              {...p}
              value={org}
              disabled={busy || loadingOrgs || orgs.isError}
              placeholder={loadingOrgs ? 'Loading organizations…' : 'Choose an organization'}
              onValueChange={(id) => {
                if (pending.current) return;
                const membership = memberships.find((item) => item.orgId === id);
                if (!membership) return;
                setSelection({ membershipId: membership.id, orgId: id });
                if (id !== org) {
                  const requestedOrg = params.get('orgId');
                  setSessionId(
                    !requestedOrg || requestedOrg === id ? (params.get('sessionId') ?? '') : '',
                  );
                }
                setFailed('');
              }}
              options={memberships.map((membership) => ({
                value: membership.orgId,
                label: membership.orgName,
              }))}
            />
          )}
        </FormField>
      ) : (
        <Callout>No organizations grant you scanning management access.</Callout>
      )}
      {org && !creating ? (
        <FormField label="Scanning session" help="This device uses the session’s shared rules.">
          {(p) => (
            <Select
              {...p}
              value={chosen}
              disabled={busy || sessions.isFetching || selected.isFetching}
              onValueChange={(id) => {
                if (!pending.current) setSessionId(id);
              }}
              options={active.map((s) => ({ value: s.id, label: s.name }))}
              placeholder={
                sessions.isPending || selected.isFetching ? 'Loading sessions…' : 'Choose a session'
              }
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
              disabled={busy}
            />
          )}
        </FormField>
      ) : null}
      {failed || orgs.error || sessions.error || selected.error ? (
        <Callout tone="danger">
          {failed || errorMessage(orgs.error ?? sessions.error ?? selected.error)}
        </Callout>
      ) : null}
      {busy || (!loadingOrgs && !orgs.isError && memberships.length > 0) ? (
        <Button
          disabled={
            busy ||
            loadingOrgs ||
            orgs.isError ||
            !org ||
            sessions.isFetching ||
            sessions.isError ||
            selected.isFetching ||
            selected.isError ||
            (!chosen && (!creating || !name.trim()))
          }
          loading={busy}
          onClick={() => void start()}
        >
          {creating ? 'Create and join' : 'Join session'}
        </Button>
      ) : null}
      {onCancel ? (
        <Button variant="ghost" onClick={onCancel}>
          Use pairing code
        </Button>
      ) : null}
    </BootCard>
  );
}

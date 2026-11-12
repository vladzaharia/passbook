import { ChevronDown, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { cn } from '@/web/lib/cn.ts';
import { revokeKeyConfirm } from '@/web/lib/confirms.ts';
import { formatDay } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { useMemberships, useSession } from '@/web/lib/session.ts';
import {
  Button,
  Combobox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Label,
  LoadMore,
  PageHeader,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import './api-keys.css';
import { CreateKeyDialog } from './create-key-dialog.tsx';
import { keyColumns } from './key-columns.tsx';
import { type ApiKey, useApiKeyPages, useRevokeKey } from './queries.ts';

export { keyState } from './queries.ts';

const flat = (q: { data?: { pages: { items: ApiKey[] }[] } | undefined }) =>
  q.data?.pages.flatMap((p) => p.items) ?? [];

function KeyContextPicker({
  memberships,
  value,
  onChange,
}: {
  memberships: readonly OrgMembership[];
  value: string | null | undefined;
  onChange: (orgId: string | undefined) => void;
}) {
  const id = useId();
  const options = [
    { value: 'platform', label: 'Platform-wide keys' },
    ...memberships.map((m) => ({ value: `org:${m.orgId}`, label: m.orgName })),
  ];
  if (options.length < 2 && value !== undefined) return null;
  if (options.length === 0) return null;
  return (
    <div className="mb-6 flex max-w-md flex-col gap-2 text-left">
      <Label htmlFor={id}>Key context</Label>
      <Combobox
        id={id}
        value={value === null ? 'platform' : value === undefined ? undefined : `org:${value}`}
        options={options}
        placeholder="Choose key context"
        searchPlaceholder="Find a key context"
        onValueChange={(next) => {
          if (next === 'platform') onChange(undefined);
          else {
            const membership = memberships.find((m) => `org:${m.orgId}` === next);
            if (membership) onChange(membership.orgId);
          }
        }}
      />
    </div>
  );
}

export function ApiKeysPage({
  onOrgChange,
  createRequested,
  onCreateRequestHandled,
}: {
  onOrgChange: (orgId: string | undefined) => void;
  createRequested: boolean;
  onCreateRequestHandled: () => void;
}) {
  const scope = useOrgScope();
  const session = useSession();
  const grants = useMemberships();
  const principal = session.isAdmin && !session.isError ? session.authed?.user.id : undefined;
  const platform = Boolean(principal && !scope.hasExplicitOrg);
  const needsMembership = scope.hasExplicitOrg;
  const loading =
    session.isLoading ||
    session.isFetching ||
    (needsMembership && (scope.isLoading || grants.isFetching));
  const failed = needsMembership && scope.isError;
  const memberships =
    grants.isFetching || scope.isError
      ? []
      : scope.memberships.filter(
          (m) => m.userId === principal && m.capabilities.includes('integrations:read'),
        );
  const membership = scope.hasExplicitOrg
    ? memberships.find((m) => m.orgId === scope.requestedOrgId)
    : undefined;
  const canRead = Boolean(principal && (platform || membership));
  const canManage = Boolean(
    principal &&
      (platform || (canRead && membership?.capabilities.includes('integrations:manage'))),
  );
  const orgId = platform ? null : membership?.orgId;
  const picker = (
    <KeyContextPicker
      memberships={memberships}
      value={canRead ? orgId : undefined}
      onChange={onOrgChange}
    />
  );

  useEffect(() => {
    if (createRequested && !loading && !failed && !canManage) onCreateRequestHandled();
  }, [createRequested, loading, failed, canManage, onCreateRequestHandled]);

  if (loading) return <SkeletonRows label="Loading organization access" />;
  if (session.isError)
    return <ErrorState subject="session" error={session.error} onRetry={session.refetch} />;
  if (failed)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!principal || !canRead || orgId === undefined) {
    const choosing = !scope.hasExplicitOrg && !membership;
    return (
      <EmptyState
        heading
        art={choosing ? 'building' : 'lock'}
        title={choosing ? 'Choose an organization' : 'You do not have access'}
        description="Choose a key context you can access."
        action={picker}
      />
    );
  }
  return (
    <ScopedApiKeys
      key={JSON.stringify([principal, orgId, canManage])}
      principal={principal}
      orgId={orgId}
      orgName={membership?.orgName ?? 'Platform-wide'}
      canManage={canManage}
      picker={picker}
      createRequested={createRequested}
      onCreateRequestHandled={onCreateRequestHandled}
    />
  );
}

function ScopedApiKeys({
  principal,
  orgId,
  orgName,
  canManage,
  picker,
  createRequested,
  onCreateRequestHandled,
}: {
  principal: string;
  orgId: string | null;
  orgName: string;
  canManage: boolean;
  picker: ReactNode;
  createRequested: boolean;
  onCreateRequestHandled: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey>();
  const [showRevoked, setShowRevoked] = useState(false);
  const [justRevoked, setJustRevoked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!createRequested || !canManage) return;
    setCreating(true);
    onCreateRequestHandled();
  }, [createRequested, canManage, onCreateRequestHandled]);
  const live = useApiKeyPages(principal, orgId, 'live');
  const revokedList = useApiKeyPages(principal, orgId, 'revoked', showRevoked);
  const revoke = useRevokeKey(principal);
  const now = Date.now();

  const liveRows = flat(live).filter((key) => key.orgId === orgId);
  const revokedCount = live.data?.pages[0]?.revokedCount ?? 0;
  const rows = showRevoked
    ? [
        ...liveRows,
        ...flat(revokedList).filter((key) => key.orgId === orgId && !justRevoked.has(key.id)),
      ]
    : liveRows;
  const empty = !live.isPending && !live.isError && liveRows.length === 0 && revokedCount === 0;
  const paging = showRevoked && !live.hasNextPage ? revokedList : live;
  const columns = useMemo(
    () =>
      keyColumns({
        orgName: (id) => (id === null ? 'Platform-wide' : id === orgId ? orgName : id),
        justRevoked,
        now,
        canRevoke: canManage,
        onRevoke: setRevoking,
      }),
    [orgId, orgName, justRevoked, now, canManage],
  );

  const create = (variant: 'primary' | 'outline') =>
    canManage ? (
      <Button variant={variant} iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
        New API key
      </Button>
    ) : null;

  return (
    <>
      <PageHeader
        title="API keys"
        breadcrumbs={[
          { label: orgId === null ? 'Platform' : 'Organization' },
          { label: 'API keys' },
        ]}
        meta={`${orgName} · All modes`}
        actions={create(empty ? 'outline' : 'primary')}
      />
      {picker}
      {live.isError && liveRows.length === 0 ? (
        <ErrorState error={live.error} onRetry={() => live.refetch()} />
      ) : (
        <div className="wl-keys">
          <h2 className="mb-3 text-lg font-semibold text-fg-strong">Credentials</h2>
          <DataTable
            caption="API keys"
            loading={
              live.isPending || (showRevoked && liveRows.length === 0 && revokedList.isPending)
            }
            fetching={live.isFetching && !live.isFetchingNextPage}
            data={rows}
            getRowId={(k) => k.id}
            empty={
              <EmptyState
                art="key"
                title={revokedCount ? 'No active API keys' : 'No API keys'}
                action={create('primary')}
              />
            }
            footer={
              <LoadMore query={paging} shown={rows.length} noun={['API key', 'API keys']} scoped />
            }
            columns={columns}
          />
          {showRevoked && revokedList.isError ? (
            <ErrorState
              inline
              subject="revoked keys"
              error={revokedList.error}
              onRetry={() => revokedList.refetch()}
            />
          ) : null}
          {revokedCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              aria-expanded={showRevoked}
              loading={showRevoked && revokedList.isPending}
              iconEnd={
                <ChevronDown
                  aria-hidden
                  className={cn('transition-transform', showRevoked && 'rotate-180')}
                />
              }
              onClick={() => setShowRevoked((s) => !s)}
            >
              {showRevoked ? 'Hide revoked' : `Show revoked (${revokedCount})`}
            </Button>
          ) : null}
        </div>
      )}
      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        principal={principal}
        orgId={orgId}
        orgName={orgName}
      />
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        {...revokeKeyConfirm(revoking?.name ?? 'key')}
        description={
          revoking ? (
            <span className="block">
              <span className="block">
                Requests using this key fail at once. This cannot be undone. Update consumers to a
                replacement first.
              </span>
              <span className="mt-3 block">Organization: {orgName}</span>
              <span className="block">Mode: {revoking.mode === 'test' ? 'Test' : 'Live'}</span>
              <span className="block">Permissions: {revoking.scopes.join(', ')}</span>
              <span className="block">Expires: {formatDay(revoking.expiresAt, 'Never')}</span>
              <span className="block">
                Last used: {formatDay(revoking.lastUsedAt, 'No use recorded')} · Consumer impact is
                not known.
              </span>
            </span>
          ) : undefined
        }
        destructive
        onConfirm={async () => {
          if (!revoking || !canManage || revoking.orgId !== orgId) return;
          const id = revoking.id;
          await revoke.mutateAsync({ id, orgId: revoking.orgId });
          setJustRevoked((s) => new Set(s).add(id));
          toast.success('Key revoked');
        }}
      />
    </>
  );
}

import { ChevronDown, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { revokeKeyConfirm } from '@/web/lib/confirms.ts';
import { formatDay } from '@/web/lib/format.ts';
import { useAdminScope, useOrgScope } from '@/web/lib/org-filter.tsx';
import { useMemberships, useSession } from '@/web/lib/session.ts';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
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

export function ApiKeysPage({
  createRequested,
  onCreateRequestHandled,
}: {
  createRequested: boolean;
  onCreateRequestHandled: () => void;
}) {
  const scope = useOrgScope();
  const session = useSession();
  const grants = useMemberships();
  const adminScope = useAdminScope();
  // The URL's scope: platform keys for an admin, or this organization's keys for a member.
  const principal = session.isError ? undefined : session.authed?.user.id;
  const platform = Boolean(session.isAdmin && principal && adminScope?.kind === 'platform');
  const needsMembership = !platform;
  const loading =
    session.isLoading ||
    session.isFetching ||
    (needsMembership && (scope.isLoading || grants.isFetching));
  const failed = needsMembership && scope.isError;
  const membership =
    grants.isFetching || scope.isError || !scope.hasExplicitOrg
      ? undefined
      : scope.memberships.find(
          (m) =>
            m.userId === principal &&
            m.orgId === scope.requestedOrgId &&
            m.capabilities.includes('integrations:read'),
        );
  const canRead = Boolean(principal && (platform || membership));
  const canManage = Boolean(
    principal &&
      (platform || (canRead && membership?.capabilities.includes('integrations:manage'))),
  );
  const orgId = platform ? null : membership?.orgId;
  useEffect(() => {
    if (createRequested && !loading && !failed && !canManage) onCreateRequestHandled();
  }, [createRequested, loading, failed, canManage, onCreateRequestHandled]);

  if (loading) return <SkeletonRows label="Loading organization access" />;
  if (session.isError)
    return <ErrorState subject="session" error={session.error} onRetry={session.refetch} />;
  if (failed)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!principal || !canRead || orgId === undefined) {
    return <EmptyState heading art="lock" title="You do not have access" />;
  }
  return (
    <ScopedApiKeys
      key={JSON.stringify([principal, orgId, canManage])}
      principal={principal}
      orgId={orgId}
      orgName={membership?.orgName ?? 'Platform'}
      canManage={canManage}
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
  createRequested,
  onCreateRequestHandled,
}: {
  principal: string;
  orgId: string | null;
  orgName: string;
  canManage: boolean;
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
        justRevoked,
        now,
        canRevoke: canManage,
        onRevoke: setRevoking,
      }),
    [justRevoked, now, canManage],
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
        meta={orgId === null ? undefined : 'All modes'}
        actions={create(empty ? 'outline' : 'primary')}
      />
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

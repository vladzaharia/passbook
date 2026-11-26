import { ChevronDown, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { revokeKeyConfirm } from '@/web/lib/confirms.ts';
import { formatDay } from '@/web/lib/format.ts';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import './api-keys.css';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { CreateKeyDialog } from './create-key-dialog.tsx';
import { keyColumns } from './key-columns.tsx';
import { KeysHeader, useKeysHost } from './keys-host.tsx';
import { type ApiKey, SCOPE_LABEL, useApiKeyPages, useRevokeKey } from './queries.ts';
import type { KeyAccess } from './use-key-access.ts';

export { keyState } from './queries.ts';

const flat = (q: { data?: { pages: { items: ApiKey[] }[] } | undefined }) =>
  q.data?.pages.flatMap((p) => p.items) ?? [];

export interface ApiKeysViewProps {
  createRequested: boolean;
  onCreateRequestHandled: () => void;
}

/** The list and its dialogs for a known access; the Workbench renders it with its own. */
export function ApiKeysView({
  access,
  createRequested,
  onCreateRequestHandled,
}: ApiKeysViewProps & { access: KeyAccess }) {
  const canManage = access.state === 'ready' && access.canManage;
  useEffect(() => {
    if (createRequested && access.state !== 'loading' && access.state !== 'org-error' && !canManage)
      onCreateRequestHandled();
  }, [createRequested, access.state, canManage, onCreateRequestHandled]);

  if (access.state === 'loading') return <SkeletonRows label="Loading organization access" />;
  if (access.state === 'session-error')
    return <ErrorState subject="session" error={access.error} onRetry={access.retry} />;
  if (access.state === 'org-error')
    return <ErrorState subject="organization access" error={access.error} onRetry={access.retry} />;
  if (access.state === 'denied') {
    return <EmptyState heading art="lock" title="You do not have access" />;
  }
  return (
    <ScopedApiKeys
      key={JSON.stringify([access.principal, access.orgId, canManage])}
      principal={access.principal}
      orgId={access.orgId}
      orgName={access.orgName}
      capabilities={access.capabilities}
      developerOrg={access.developerOrg}
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
  capabilities,
  developerOrg,
  canManage,
  createRequested,
  onCreateRequestHandled,
}: {
  principal: string;
  orgId: string | null;
  orgName: string;
  capabilities: readonly OrgCapability[] | null;
  developerOrg: boolean;
  canManage: boolean;
  createRequested: boolean;
  onCreateRequestHandled: () => void;
}) {
  const host = useKeysHost();
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
  const empty = !live.isPending && !live.isError && rows.length === 0;
  const paging = showRevoked && !live.hasNextPage ? revokedList : live;
  const columns = useMemo(
    () =>
      keyColumns({
        orgId,
        justRevoked,
        now,
        canRevoke: canManage,
        onRevoke: setRevoking,
        creatorLink: !host,
      }),
    [orgId, justRevoked, now, canManage, host],
  );

  const create = (variant: 'primary' | 'outline') =>
    canManage ? (
      <Button variant={variant} iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
        New API key
      </Button>
    ) : null;

  return (
    <>
      <KeysHeader title="API keys" actions={empty ? undefined : create('primary')} />
      {live.isError && liveRows.length === 0 ? (
        <ErrorState error={live.error} onRetry={() => live.refetch()} />
      ) : (
        <div className="wl-keys">
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
        capabilities={capabilities}
        developerOrg={developerOrg}
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
              <span className="block">
                Permissions: {revoking.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}
              </span>
              <span className="block">Expires: {formatDay(revoking.expiresAt, 'No expiry')}</span>
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

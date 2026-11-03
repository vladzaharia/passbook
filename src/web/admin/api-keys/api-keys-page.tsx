import { ChevronDown, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { revokeKeyConfirm } from '@/web/lib/confirms.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  toast,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import './api-keys.css';
import { CreateKeyDialog } from './create-key-dialog.tsx';
import { keyColumns } from './key-columns.tsx';
import { type ApiKey, keyState, useApiKeyPages, useRevokeKey } from './queries.ts';

export { keyState } from './queries.ts';

const flat = (q: { data?: { pages: { items: ApiKey[] }[] } | undefined }) =>
  q.data?.pages.flatMap((p) => p.items) ?? [];

/**
 * Live keys page by cursor for the top-bar org; revoked ones load behind "Show revoked (n)" and
 * follow them. A key revoked here stays in place, dimmed, until the list reloads.
 */
export function ApiKeysPage() {
  const orgName = useOrgNames();
  const { orgId } = useOrgScope();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey>();
  const [showRevoked, setShowRevoked] = useState(false);
  const [justRevoked, setJustRevoked] = useState<ReadonlySet<string>>(new Set());
  const live = useApiKeyPages(orgId, 'live');
  const revokedList = useApiKeyPages(orgId, 'revoked', showRevoked);
  const revoke = useRevokeKey();
  const now = Date.now();

  const liveRows = flat(live);
  const revokedCount = live.data?.pages[0]?.revokedCount ?? 0;
  const rows = showRevoked
    ? [...liveRows, ...flat(revokedList).filter((k) => !justRevoked.has(k.id))]
    : liveRows;
  const empty = !live.isPending && !live.isError && liveRows.length === 0 && revokedCount === 0;
  const withStatus = rows.some((k) => keyState(k, now) !== 'active');
  // Live pages first; once they run out, Load more pages the revoked ones.
  const paging = showRevoked && !live.hasNextPage ? revokedList : live;

  const columns = useMemo(
    () => keyColumns({ orgName, justRevoked, now, withStatus, onRevoke: setRevoking }),
    [orgName, justRevoked, now, withStatus],
  );

  const create = (variant: 'primary' | 'outline') => (
    <Button variant={variant} iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
      New API key
    </Button>
  );

  return (
    <>
      <PageHeader title="API keys" actions={create(empty ? 'outline' : 'primary')} />
      {live.isError && liveRows.length === 0 ? (
        <ErrorState error={live.error} onRetry={() => live.refetch()} />
      ) : (
        <div className="wl-keys">
          <DataTable
            caption="API keys"
            loading={live.isPending}
            fetching={live.isFetching && !live.isFetchingNextPage}
            data={rows}
            getRowId={(k) => k.id}
            empty={<EmptyState art="key" title="No API keys" action={create('primary')} />}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3">
                <LoadMore
                  query={paging}
                  shown={rows.length}
                  noun={['API key', 'API keys']}
                  scoped
                />
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
            }
            columns={columns}
          />
        </div>
      )}
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        {...revokeKeyConfirm(revoking?.name ?? 'key')}
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          const id = revoking.id;
          await revoke.mutateAsync(id);
          setJustRevoked((s) => new Set(s).add(id));
          toast.success('Key revoked');
        }}
      />
    </>
  );
}

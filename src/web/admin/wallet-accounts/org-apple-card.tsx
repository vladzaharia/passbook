import { useMemo, useState } from 'react';
import { MANAGED_PREFIX } from '@/shared/identity-handle.ts';
import { Button, Card, CardBody, CardHeader, ErrorState, SkeletonRows } from '@/web/ui/index.ts';
import { IdentityStatusPill, KIND_LABEL, renewalText } from './apple/identity-status.tsx';
import { useOrgWalletIdentities } from './apple/managed-queries.ts';
import { NewManagedIdentityDialog } from './apple/new-managed-dialog.tsx';
import { OrgAppleHistory } from './org-apple-history.tsx';

/** The organization's Apple identity: one line, and its history. */
export function OrgAppleCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const query = useOrgWalletIdentities(orgId);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState(false);
  const identity = useMemo(
    () => query.data?.items.find((i) => i.kind !== 'platform'),
    [query.data],
  );
  return (
    <Card>
      <CardHeader
        title="Apple"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setHistory(true)}>
            History
          </Button>
        }
      />
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        {query.isPending ? (
          <SkeletonRows rows={1} label="Loading Apple identity" />
        ) : query.isError ? (
          <ErrorState
            subject="Apple identity"
            error={query.error}
            onRetry={() => query.refetch()}
          />
        ) : identity ? (
          <>
            <p className="min-w-0 text-sm">
              <span className="break-all font-mono">{identity.identifier}</span>
              <span className="text-fg-muted">
                {' · '}
                {KIND_LABEL[identity.kind]}
                {' · '}
                {renewalText(identity)}
              </span>
            </p>
            <IdentityStatusPill status={identity.status} />
          </>
        ) : (
          <>
            <p className="text-sm text-fg-muted">Signs with PassBook's ID</p>
            {canManage ? (
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                Get a managed ID
              </Button>
            ) : null}
          </>
        )}
      </CardBody>
      <NewManagedIdentityDialog open={creating} onOpenChange={setCreating} orgId={orgId} />
      <OrgAppleHistory
        orgId={orgId}
        identityId={identity?.id}
        identifier={identity?.identifier ?? `${MANAGED_PREFIX}…`}
        open={history}
        onOpenChange={setHistory}
      />
    </Card>
  );
}

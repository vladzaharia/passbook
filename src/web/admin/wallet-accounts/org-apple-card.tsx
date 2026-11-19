import { useMemo } from 'react';
import { Card, CardBody, CardHeader, ErrorState, SkeletonRows } from '@/web/ui/index.ts';
import { ApnsPill, ExpiryPill } from '../identities/expiry.tsx';
import { useOrgIdentities } from '../identities/queries.ts';

/** The organization's own Apple identity, read-only here: PassBook's platform identity signs otherwise. */
export function OrgAppleCard({ orgId }: { orgId: string }) {
  const query = useOrgIdentities(orgId);
  const now = useMemo(() => Date.now(), []);
  return (
    <Card>
      <CardHeader title="Apple" />
      <CardBody className="flex flex-col gap-3">
        {query.isPending ? (
          <SkeletonRows rows={2} label="Loading Apple identity" />
        ) : query.isError ? (
          <ErrorState
            subject="Apple identity"
            error={query.error}
            onRetry={() => query.refetch()}
          />
        ) : query.data.items.length === 0 ? (
          <p className="text-sm text-fg-muted">Signs with PassBook's identity.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {query.data.items.map((identity) => (
              <li
                key={identity.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="break-words font-medium text-fg-strong">{identity.label}</p>
                  <p className="break-all font-mono text-xs text-fg-muted">
                    {identity.passTypeIdentifier}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <ExpiryPill identity={identity} now={now} />
                  <ApnsPill identity={identity} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

import { AlertTriangle } from 'lucide-react';
import { DRIFT_KIND } from '@/shared/copy/idp-platform.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { humanizeStatus } from '@/web/lib/status.ts';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  MetaLink,
  RelTime,
  SkeletonRows,
  useNow,
} from '@/web/ui/index.ts';
import { useDrift } from './idp-queries.ts';

/** Where Polaris ID and PassBook disagree. Empty is a good state, so the buddy shows it. */
export function IdpDriftCard({ buddy }: { buddy: boolean }) {
  const drift = useDrift();
  const now = useNow(60_000);
  const items = drift.data?.items ?? [];
  if (drift.isSuccess && items.length === 0) {
    return buddy ? (
      <EmptyState art="pulse" title="No differences" />
    ) : (
      <Card>
        <CardHeader title="Differences" />
        <CardBody>
          <EmptyState inline art="pulse" title="No differences" />
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Differences" />
      <CardBody>
        {drift.isPending ? (
          <SkeletonRows label="Loading differences" />
        ) : drift.isError ? (
          <ErrorState
            inline
            subject="differences"
            error={drift.error}
            onRetry={() => drift.refetch()}
          />
        ) : (
          <ListRows label="Differences">
            {items.map((d) => {
              const kind = DRIFT_KIND[d.kind];
              return (
                <ListRow
                  key={d.id}
                  rowId={d.id}
                  leading={<AlertTriangle aria-hidden className="size-4 text-warning" />}
                  title={kind?.label ?? humanizeStatus(d.kind)}
                  pills={<code className="font-mono text-xs text-fg-muted">{d.target}</code>}
                  meta={
                    <>
                      {kind?.hint ? `${kind.hint} ` : null}
                      Found <RelTime at={d.foundAt} now={now} />.
                    </>
                  }
                  trailing={
                    d.userId ? (
                      <MetaLink
                        to="/admin/users/$userId"
                        params={{ userId: d.userId }}
                        icon={ENTITY.user.icon}
                      >
                        User
                      </MetaLink>
                    ) : null
                  }
                />
              );
            })}
          </ListRows>
        )}
      </CardBody>
    </Card>
  );
}

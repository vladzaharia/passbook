import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { formatCount } from '../../../lib/format.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  RelTime,
  RowLink,
  Skeleton,
  useNow,
} from '../../../ui/index.ts';
import { useRecentImports } from './api.ts';
import { stateBadge } from './state-tone.ts';

/** The last 10 imports of this mode, each a link to its page. */
export function RecentImports({ orgId }: { orgId: string }) {
  const recent = useRecentImports(orgId);
  const now = useNow();
  const items = recent.data?.items ?? [];
  return (
    <Card>
      <CardHeader title={C.recent} />
      <CardBody>
        {recent.isPending ? (
          <Skeleton className="h-16" />
        ) : recent.isError ? (
          <ErrorState
            inline
            subject="imports"
            error={recent.error}
            onRetry={() => recent.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState inline art="passes" title={C.noRecent} />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((imp) => (
              <li
                key={imp.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <RowLink
                    to="/admin/passes/import/$importId"
                    params={{ importId: imp.id }}
                    search={{ orgId }}
                  >
                    {imp.source.name}
                  </RowLink>
                  <p className="text-xs text-fg-muted">
                    {imp.counts ? `${formatCount(imp.counts.rows)} rows · ` : ''}
                    <RelTime at={imp.createdAt} now={now} />
                  </p>
                </div>
                <Badge tone={stateBadge(imp).tone}>{stateBadge(imp).label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

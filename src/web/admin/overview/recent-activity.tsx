import { Link } from '@tanstack/react-router';
import { actionOf } from '@/web/lib/actions.ts';
import { cn } from '@/web/lib/cn.ts';
import {
  Card,
  CardBody,
  CardHeader,
  CardLink,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { TONE_TEXT } from '../audit/audit-rows.tsx';
import { targetRef } from '../audit/labels.ts';
import { useAuditLog } from '../audit/queries.ts';
import { formatDateTime, formatRelative } from './format.ts';

/** Six one-line rows without sign-ins; each opens its target, or the entry when it has none. */
export function RecentActivity({ orgId }: { orgId: string | undefined }) {
  const log = useAuditLog({ orgId, excludeAction: 'auth.' }, 6);
  const items = log.data?.pages[0]?.items ?? [];
  const now = Date.now();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Recent activity"
        actions={<CardLink to="/admin/audit">Audit log</CardLink>}
      />
      <CardBody className="flex flex-1 flex-col">
        {log.isPending ? (
          <SkeletonRows rows={6} label="Loading activity" />
        ) : log.isError ? (
          <ErrorState error={log.error} onRetry={() => log.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            inline
            art="activity"
            title="No activity yet"
            className="flex-1 justify-center"
          />
        ) : (
          <ListRows label="Recent activity">
            {items.slice(0, 6).map((e) => {
              const action = actionOf(e.action);
              const target = targetRef(e);
              const link = target?.to
                ? { to: target.to }
                : { to: '/admin/audit', search: { entry: e.id } };
              return (
                <ListRow
                  key={e.id}
                  className="relative"
                  leading={<action.icon aria-hidden className={cn(TONE_TEXT[action.tone])} />}
                  title={
                    <Link
                      to={link.to as never}
                      search={link.search as never}
                      className="rounded-sm after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {action.label}
                      {target ? <span className="ml-2 text-fg-muted">{target.name}</span> : null}
                    </Link>
                  }
                  trailing={
                    <time
                      dateTime={new Date(e.at).toISOString()}
                      title={formatDateTime(e.at)}
                      className="text-xs whitespace-nowrap text-fg-muted"
                    >
                      {formatRelative(e.at, now)}
                    </time>
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

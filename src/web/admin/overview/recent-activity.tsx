import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { actionOf } from '@/web/lib/actions.ts';
import { cn } from '@/web/lib/cn.ts';
import { entityLabel } from '@/web/lib/entity-label.ts';
import { entryLabel } from '@/web/lib/entry-label.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  RelTime,
  RowLink,
  SkeletonRows,
  useNow,
} from '@/web/ui/index.ts';
import { TONE_TEXT } from '../audit/audit-rows.tsx';
import { targetRef } from '../audit/labels.ts';
import { usePlatformAuditLog, useTenantAuditLog } from '../audit/queries.ts';
import { useOrgNames } from '../orgs/queries.ts';

/** Six rows without sign-ins; each opens its target, or the entry when it has none. */
export function RecentActivity({ orgId }: { orgId: string | undefined }) {
  // Refetch on every visit: what just happened is the point of this card.
  const log = usePlatformAuditLog({ filterOrgId: orgId, excludeAction: 'auth.' }, 6, 0);
  const orgName = useOrgNames();
  return <RecentCard log={log} orgLabel={orgName} auditSearch={{ filterOrgId: orgId }} />;
}

/** A member's view: their organization's log, which needs `audit:read`. */
export function OrgRecentActivity({
  orgId,
  hideEmpty = false,
}: {
  orgId: string;
  orgName?: string;
  /** The page already says it is empty: no second empty card. */
  hideEmpty?: boolean;
}) {
  const log = useTenantAuditLog(orgId, { excludeAction: 'auth.' }, 6, 0);
  return (
    <RecentCard
      log={log}
      orgLabel={() => ''}
      auditSearch={{}}
      note="All modes"
      hideEmpty={hideEmpty}
    />
  );
}

function RecentCard({
  log,
  orgLabel: orgName,
  auditSearch,
  note,
  hideEmpty = false,
}: {
  log: ReturnType<typeof useTenantAuditLog>;
  orgLabel: (id: string | null) => string;
  auditSearch: { filterOrgId?: string | undefined };
  note?: string | undefined;
  hideEmpty?: boolean;
}) {
  const items = log.data?.pages[0]?.items ?? [];
  // The row's own label covers closed and personal orgs; an id is never a name.
  const orgNameOf = (e: (typeof items)[number]) => {
    if (e.orgLabel) return e.orgLabel;
    const name = orgName(e.orgId);
    return name === e.orgId ? 'Deleted organization' : name;
  };
  const now = useNow();
  if (hideEmpty && !log.isPending && !log.isError && items.length === 0) return null;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Recent activity"
        actions={
          <Button asChild variant="ghost" size="sm" iconEnd={<ChevronRight aria-hidden />}>
            <Link to="/admin/audit" search={auditSearch}>
              Audit log
            </Link>
          </Button>
        }
      />
      <CardBody className="flex flex-1 flex-col">
        {note ? <p className="mb-3 text-xs text-fg-muted">{note}</p> : null}
        {log.isPending ? (
          <SkeletonRows rows={6} label="Loading activity" />
        ) : log.isError ? (
          <ErrorState inline error={log.error} onRetry={() => log.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            inline
            art="activity"
            still
            title="No activity yet"
            className="flex-1 justify-center"
          />
        ) : (
          <ListRows label="Recent activity">
            {items.slice(0, 6).map((e) => {
              const action = actionOf(e.action);
              const target = targetRef(e);
              const actor = entityLabel(
                e.actorLabel,
                {
                  user: 'User',
                  api_key: 'API key',
                  system: 'System',
                  connection: 'Connection',
                  device: 'Device',
                  scanner: 'Scanner',
                }[e.actorType] ?? 'Someone',
              );
              const link = target?.to
                ? { to: target.to }
                : { to: '/admin/audit', search: { entry: e.id, ...auditSearch } };
              return (
                <ListRow
                  key={e.id}
                  className="relative"
                  leading={<action.icon aria-hidden className={cn(TONE_TEXT[action.tone])} />}
                  title={
                    <RowLink
                      to={link.to}
                      search={link.search}
                      className="whitespace-normal after:absolute after:inset-0"
                    >
                      {entryLabel(e)}
                    </RowLink>
                  }
                  meta={[target?.name, actor, orgNameOf(e)].filter(Boolean).join(' · ')}
                  trailing={
                    <span className="text-xs whitespace-nowrap text-fg-muted">
                      <RelTime at={e.at} now={now} />
                    </span>
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

import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { z } from 'zod';
import type { UserPassSchema } from '@/shared/contracts/users.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { canAccessAdminPath } from '@/web/lib/guards.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { orgPath } from '@/web/lib/scope.ts';
import { useSession } from '@/web/lib/session.ts';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  LoadMore,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDayIn } from '../../../shared/format-date.ts';
import { ENTITY } from '../../lib/entities.ts';
import { useUserPasses } from './queries.ts';

type UserPass = z.infer<typeof UserPassSchema>;

const channelsLabel = (p: UserPass) =>
  p.channels.length ? p.channels.map((c) => CHANNEL_LABEL[c]).join(', ') : 'No wallet yet';

/** The person's passes in every organization. A pass opens in its organization when you can open it. */
export function UserPassesCard({ userId }: { userId: string }) {
  const query = useUserPasses(userId);
  const scope = useOrgScope();
  const { isAdmin } = useSession();
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const canOpen = (p: UserPass) => {
    const membership = scope.memberships.find((m) => m.orgId === p.orgId);
    return canAccessAdminPath(orgPath(p.orgId, `/passes/${p.id}`), isAdmin, membership);
  };

  return (
    <Card id="passes">
      <CardHeader title="Passes" />
      {query.isPending ? (
        <CardBody>
          <SkeletonRows rows={3} label="Loading passes" />
        </CardBody>
      ) : query.isError && rows.length === 0 ? (
        <ErrorState subject="passes" error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState art={ENTITY.pass.art} title="No passes" />
      ) : (
        <CardBody>
          <ListRows label="Passes">
            {rows.map((p) => {
              const day = (ms: number) => formatDayIn(ms, p.timeZone);
              const open = canOpen(p);
              const meta = [
                p.templateName,
                channelsLabel(p),
                `Issued ${day(p.issuedAt)}`,
                `Updated ${day(p.updatedAt)}`,
                ...(open ? [] : ['Open the org to see details']),
              ].join(' · ');
              const org = p.orgStatus === 'suspended' ? `${p.orgName} (suspended)` : p.orgName;
              return (
                <ListRow
                  key={p.id}
                  rowId={p.id}
                  title={
                    open ? (
                      <Link
                        to="/admin/o/$orgId/passes/$passId"
                        params={{ orgId: p.orgId, passId: p.id }}
                        className="text-accent-fg hover:underline"
                      >
                        {org}
                      </Link>
                    ) : (
                      org
                    )
                  }
                  pills={<StatusPill status={p.status} />}
                  meta={meta}
                />
              );
            })}
          </ListRows>
          <LoadMore query={query} shown={rows.length} noun={['pass', 'passes']} />
        </CardBody>
      )}
    </Card>
  );
}

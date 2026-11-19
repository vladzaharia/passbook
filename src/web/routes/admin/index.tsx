import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { canAccessAdminPath } from '../../lib/guards.ts';
import { legacyAdminTarget } from '../../lib/legacy-admin.ts';
import { firstAllowedPath } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { orgPath, parseAdminPath } from '../../lib/scope.ts';
import { readRemembered, readTabScope } from '../../lib/scope-store.ts';
import { isAdmin, membershipsQuery, sessionQuery } from '../../lib/session.ts';
import { Card, CardBody } from '../../ui/card.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { EntityAvatar } from '../../ui/entity.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { ListRow, ListRows } from '../../ui/list-row.tsx';
import { PageHeader } from '../../ui/page-header.tsx';
import { RowLink } from '../../ui/row-link.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';

/** A section to open in the chosen organization ("/passes"), from a legacy link. */
const searchSchema = z.object({
  next: z
    .string()
    .regex(/^(\/[a-z0-9-]+)+$/)
    .max(200)
    .optional()
    .catch(undefined),
});

/** Several organizations and none remembered: the principal picks one. */
function ScopeChooser() {
  const { next } = Route.useSearch();
  const scope = useOrgScope();
  if (scope.isLoading) return <SkeletonRows label="Loading organizations" />;
  if (scope.isError) {
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  }
  if (scope.memberships.length === 0) {
    return <EmptyState heading art="building" title="No organizations" />;
  }
  return (
    <>
      <PageHeader title="Choose an organization" />
      <Card className="max-w-xl">
        <CardBody>
          <ListRows label="Organizations">
            {scope.memberships.map((m) => {
              const wanted = orgPath(m.orgId, next ?? '');
              const to = canAccessAdminPath(wanted, false, m)
                ? wanted
                : (firstAllowedPath({ kind: 'org', orgId: m.orgId }, false, m) ?? orgPath(m.orgId));
              return (
                <ListRow
                  key={m.orgId}
                  leading={<EntityAvatar kind="org" id={m.orgId} name={m.orgName} />}
                  title={<RowLink to={to}>{m.orgName}</RowLink>}
                />
              );
            })}
          </ListRows>
        </CardBody>
      </Card>
    </>
  );
}

export const Route = createFileRoute('/admin/')({
  validateSearch: searchSchema,
  // The remembered scope if still reachable, else the platform for admins, else the only
  // organization, else the chooser. Old /admin?orgId= links open that organization.
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    const userId = session.authenticated ? session.user.id : undefined;
    const grants = await context.queryClient.ensureQueryData(membershipsQuery);
    const memberships = grants.items.filter((m) => m.userId === userId && m.revokedAt === null);
    const raw = (location.search ?? {}) as Record<string, unknown>;
    if (raw.next !== undefined) return;
    const target = legacyAdminTarget('/admin', raw, {
      platformAdmin: isAdmin(session),
      memberships,
      tab: readTabScope(),
      remembered: readRemembered(),
    });
    if (!target || target.to === '/admin') return;
    const scope = parseAdminPath(target.to).scope;
    const membership =
      scope?.kind === 'org' ? memberships.find((m) => m.orgId === scope.orgId) : undefined;
    // A member whose role has no overview opens the first section it does have.
    const to =
      scope?.kind === 'org' && membership && !canAccessAdminPath(target.to, false, membership)
        ? (firstAllowedPath(scope, false, membership) ?? target.to)
        : target.to;
    throw redirect({ to, search: target.search, replace: true });
  },
  component: ScopeChooser,
});

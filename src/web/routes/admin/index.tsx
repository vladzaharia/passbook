import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { canAccessAdminPath } from '../../lib/guards.ts';
import { carryOrgScope, legacyAdminTarget } from '../../lib/legacy-admin.ts';
import { parseAdminPath, platformPath } from '../../lib/scope.ts';
import { readRemembered, readTabScope } from '../../lib/scope-store.ts';
import { isAdmin, membershipsQuery, sessionQuery } from '../../lib/session.ts';
import { OrgChooser } from '../../ui/layout/org-chooser.tsx';

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
  return <OrgChooser next={next ?? ''} />;
}

export const Route = createFileRoute('/admin/')({
  validateSearch: searchSchema,
  // An Overview link from inside an organization opens that organization's overview.
  search: carryOrgScope,
  // The remembered scope if still reachable, else the platform for admins, else the only
  // organization, else the chooser. Old /admin?orgId= links open that organization.
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    const userId = session.authenticated ? session.user.id : undefined;
    const raw0 = (location.search ?? {}) as Record<string, unknown>;
    const last = readTabScope() ?? readRemembered();
    // A platform admin headed for the platform does not wait for organization grants.
    if (
      isAdmin(session) &&
      raw0.orgId === undefined &&
      raw0.next === undefined &&
      last?.kind !== 'org'
    ) {
      const { orgId: _o, filterOrgId, ...kept } = raw0;
      throw redirect({ to: platformPath(), search: { ...kept, filterOrgId }, replace: true });
    }
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
        ? ((await import('../../lib/nav.ts')).firstAllowedPath(scope, false, membership) ??
          target.to)
        : target.to;
    throw redirect({ to, search: target.search, replace: true });
  },
  component: ScopeChooser,
});

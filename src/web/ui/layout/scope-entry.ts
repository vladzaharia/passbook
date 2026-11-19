import { firstAllowedPath } from '../../lib/nav.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { platformPath } from '../../lib/scope.ts';
import { useSession } from '../../lib/session.ts';

/** A scope the principal can open, as a way out of one they cannot: an organization, else the platform. */
export function useReachableScope(): { to: string; label: string } | undefined {
  const { isAdmin } = useSession();
  const { memberships, requestedOrgId } = useOrgScope();
  for (const membership of memberships) {
    if (membership.orgId === requestedOrgId) continue;
    const to = firstAllowedPath({ kind: 'org', orgId: membership.orgId }, isAdmin, membership);
    if (to) return { to, label: `Go to ${membership.orgName}` };
  }
  return isAdmin ? { to: platformPath(), label: 'Go to Platform' } : undefined;
}

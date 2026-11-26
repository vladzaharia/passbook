import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { useAdminScope, useOrgScope } from '@/web/lib/org-filter.tsx';
import { useMemberships, useSession } from '@/web/lib/session.ts';

export type KeyAccess =
  | { state: 'loading' }
  | { state: 'session-error'; error: unknown; retry: () => void }
  | { state: 'org-error'; error: unknown; retry: () => void }
  | { state: 'denied' }
  | {
      state: 'ready';
      principal: string;
      /** Null for the platform's keys. */
      orgId: string | null;
      orgName: string;
      canManage: boolean;
      /** What the member may delegate to a key; null for the platform. */
      capabilities: readonly OrgCapability[] | null;
      /** A developer sandbox (test-only) organization. */
      developerOrg: boolean;
      /** The audit log, where a key's activity is read from. */
      canAudit: boolean;
      /** False in a break-glass or email session: it makes no Platform key. */
      idp: boolean;
    };

/**
 * What the signed-in person may do with the keys of the URL's scope: platform keys for an admin on
 * the platform pages, or this organization's keys for a member who can read integrations.
 */
export function useKeyAccess(): KeyAccess {
  const scope = useOrgScope();
  const session = useSession();
  const grants = useMemberships();
  const adminScope = useAdminScope();
  const principal = session.isError ? undefined : session.authed?.user.id;
  const platform = Boolean(session.isAdmin && principal && adminScope?.kind === 'platform');
  const needsMembership = !platform;
  const loading =
    session.isLoading ||
    session.isFetching ||
    (needsMembership && (scope.isLoading || grants.isFetching));
  if (loading) return { state: 'loading' };
  if (session.isError)
    return { state: 'session-error', error: session.error, retry: () => void session.refetch() };
  if (needsMembership && scope.isError)
    return { state: 'org-error', error: scope.error, retry: () => void scope.refetch() };
  const membership =
    grants.isFetching || scope.isError || !scope.hasExplicitOrg
      ? undefined
      : scope.memberships.find(
          (m) =>
            m.userId === principal &&
            m.orgId === scope.requestedOrgId &&
            m.capabilities.includes('integrations:read'),
        );
  const canRead = Boolean(principal && (platform || membership));
  const orgId = platform ? null : membership?.orgId;
  if (!principal || !canRead || orgId === undefined) return { state: 'denied' };
  return {
    state: 'ready',
    principal,
    orgId,
    orgName: membership?.orgName ?? 'Platform',
    developerOrg: Boolean(membership?.testOnly),
    capabilities: platform ? null : (membership?.capabilities ?? []),
    canManage: platform || Boolean(membership?.capabilities.includes('integrations:manage')),
    canAudit: platform || Boolean(membership?.capabilities.includes('audit:read')),
    idp: session.authed?.amr === 'oidc',
  };
}

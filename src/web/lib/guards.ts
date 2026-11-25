import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import type { OrgCapability, OrgMembership } from '@/shared/contracts/org-membership.ts';
import { canUseSpace, needsPocketId } from '@/shared/spaces.ts';
import { ApiError } from './errors.ts';
import { safeNext } from './redirect.ts';
import { parseAdminPath } from './scope.ts';
import { type AuthedSession, membershipsQuery, sessionQuery } from './session.ts';

export const ADMIN_PREFIX = '/admin';

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function hasCapability(membership: OrgMembership | undefined, capability: OrgCapability): boolean {
  return membership?.revokedAt === null && membership.capabilities.includes(capability);
}

/** The organization overview reads what the metrics endpoint does: the org and its passes. */
export function canSeeOrgOverview(membership: OrgMembership | undefined): boolean {
  return hasCapability(membership, 'org:read') && hasCapability(membership, 'passes:read');
}

/** A page inside an organization scope; `rest` is the path after /admin/o/$orgId. */
export function canAccessOrgSection(rest: string, membership: OrgMembership | undefined): boolean {
  const path = rest.replace(/\/+$/, '');
  if (path === '') return canSeeOrgOverview(membership);
  if (path === '/settings') return hasCapability(membership, 'org:read');
  if (path === '/retention' || path === '/plan') return hasCapability(membership, 'org:read');
  if (within(path, '/members')) return hasCapability(membership, 'members:manage');
  if (within(path, '/wallet-accounts') || within(path, '/brand'))
    return hasCapability(membership, 'org:read');
  if (within(path, '/audit')) return hasCapability(membership, 'audit:read');
  if (within(path, '/api-keys')) return hasCapability(membership, 'integrations:read');
  if (within(path, '/passes')) {
    return hasCapability(membership, path === '/passes/new' ? 'passes:operate' : 'passes:read');
  }
  // Blueprints are shared starters: any template reader may browse them and make a template.
  if (within(path, '/blueprints')) return hasCapability(membership, 'templates:read');
  if (within(path, '/templates')) {
    const editing =
      path === '/templates/upload' ||
      path === '/templates/new' ||
      /^\/templates\/[^/]+\/design$/.test(path);
    if (!hasCapability(membership, 'templates:read')) return false;
    if (editing) return hasCapability(membership, 'templates:author');
    // Pass issuance can read templates without granting access to template management.
    return (
      hasCapability(membership, 'templates:author') ||
      hasCapability(membership, 'templates:review') ||
      hasCapability(membership, 'templates:publish')
    );
  }
  if (within(path, '/connections')) {
    return hasCapability(
      membership,
      path === '/connections/new' || path === '/connections/webhooks/new'
        ? 'integrations:manage'
        : 'integrations:read',
    );
  }
  if (within(path, '/scanning')) return hasCapability(membership, 'scanning:read');
  if (within(path, '/messages')) {
    return hasCapability(
      membership,
      path === '/messages/new' ? 'messages:manage' : 'messages:read',
    );
  }
  if (within(path, '/test-inbox')) return hasCapability(membership, 'passes:read');
  return false;
}

/**
 * Platform pages need platform rights; an organization's pages need an active membership in
 * that exact organization. Platform status never opens an organization, and the scope in the
 * URL is never a grant on its own.
 */
export function canAccessAdminPath(
  pathname: string,
  platformAdmin: boolean,
  membership?: OrgMembership,
): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === ADMIN_PREFIX || path === '/admin/account') return true;
  const { scope, rest } = parseAdminPath(path);
  if (!scope) return false;
  if (scope.kind === 'platform') return platformAdmin;
  return membership?.orgId === scope.orgId && canAccessOrgSection(rest, membership);
}

/** Routes the session guard skips: the sign-in page. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/login';
}

/** Holder pages that exist; any other URL is a 404 the signed-out visitor may see. */
export function isKnownPortalPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return path === '/' || path === '/account' || /^\/passes\/[^/]+$/.test(path);
}

export async function requireSession(
  queryClient: QueryClient,
  next: string,
): Promise<AuthedSession> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (!session.authenticated) {
    // Home is no destination: signing in picks it (the console for admins, My passes otherwise).
    const target = safeNext(next);
    // A pass page's "My passes" row lands here: say which email to use (LOGIN_REASONS.pass).
    const search =
      target === '/'
        ? {}
        : {
            next: target,
            ...(/^\/passes\/[^/?#]+/.test(target) ? { reason: 'pass' as const } : {}),
          };
    throw redirect({ to: '/login', search });
  }
  return session;
}

/** Admit a platform admin or a principal with at least one active organization membership. */
export async function requireAdminConsole(
  queryClient: QueryClient,
  next: string,
): Promise<AuthedSession> {
  const session = await requireSession(queryClient, next);
  // An email link never reaches the console; the route says so (PolarisIdRequired).
  if (needsPocketId('admin', session.amr, session.consoleUntil)) return session;
  if (!canUseSpace('admin', { ...session, orgMember: true })) {
    throw new ApiError({ status: 403, code: 'forbidden', detail: 'Admin access required.' });
  }
  if (!session.roles.includes('admin')) {
    // fetchQuery refreshes invalidated grants; an error with retained data must be retried too.
    const previous = queryClient.getQueryState(membershipsQuery.queryKey);
    const memberships = await queryClient.fetchQuery({
      ...membershipsQuery,
      ...(previous?.status === 'error' ? { staleTime: 0 } : {}),
    });
    const state = queryClient.getQueryState(membershipsQuery.queryKey);
    const current = queryClient.getQueryState(sessionQuery.queryKey);
    if (
      state?.status !== 'success' ||
      state.isInvalidated ||
      current?.status !== 'success' ||
      !current.data?.authenticated ||
      current.data.user.id !== session.user.id ||
      memberships.items.some((membership) => membership.userId !== session.user.id) ||
      !memberships.items.some((membership) => membership.revokedAt === null)
    ) {
      throw new ApiError({ status: 403, code: 'forbidden', detail: 'Admin access required.' });
    }
  }
  return session;
}

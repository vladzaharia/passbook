import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import type { OrgCapability, OrgMembership } from '@/shared/contracts/org-membership.ts';
import { ApiError } from './errors.ts';
import { safeNext } from './redirect.ts';
import { type AuthedSession, membershipsQuery, sessionQuery } from './session.ts';

export const ADMIN_PREFIX = '/admin';

const TENANT_PATHS = [
  '/admin/passes',
  '/admin/templates',
  '/admin/connections',
  '/admin/scanning',
  '/admin/messages',
  '/admin/test-inbox',
];
const PLATFORM_PATHS = [
  '/admin/users',
  '/admin/status',
  '/admin/audit',
  '/admin/identities',
  '/admin/settings',
  '/admin/api-keys',
];

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function orgDetailId(pathname: string): string | undefined {
  const encoded = /^\/admin\/orgs\/([^/]+)$/.exec(pathname)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** Platform organization details and tenant workspaces share a path, but not authority. */
export function isTenantAdminPath(pathname: string, view?: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return (
    (view === 'workspace' && /^\/admin\/orgs\/[^/]+$/.test(path)) ||
    TENANT_PATHS.some((prefix) => within(path, prefix))
  );
}

/** Detail links resolve their owning organization from the resource, not browser scope. */
export function isTenantResourceDetail(pathname: string, view?: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const item = /^\/admin\/(passes|connections|templates|messages)\/([^/]+)$/.exec(path);
  if (item) {
    const [, resource, id] = item;
    return resource === 'templates' ? id !== 'upload' : id !== 'new';
  }
  return (
    (view === 'workspace' && /^\/admin\/orgs\/[^/]+$/.test(path)) ||
    /^\/admin\/templates\/[^/]+\/design$/.test(path) ||
    /^\/admin\/scanning\/(?:events|scanners|sessions)\/[^/]+$/.test(path)
  );
}

function hasCapability(membership: OrgMembership | undefined, capability: OrgCapability): boolean {
  return membership?.revokedAt === null && membership.capabilities.includes(capability);
}

/** Membership capabilities, never platform status or a selected ID alone, authorize tenant pages. */
export function canAccessAdminPath(
  pathname: string,
  platformAdmin: boolean,
  membership?: OrgMembership,
  view?: string,
): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/admin/account') return true;
  if (
    path === '/admin' ||
    path === '/admin/orgs' ||
    PLATFORM_PATHS.some((prefix) => within(path, prefix))
  ) {
    return platformAdmin;
  }
  if (/^\/admin\/orgs\/[^/]+$/.test(path)) {
    const orgId = orgDetailId(path);
    if (orgId === undefined) return false;
    return view === 'workspace'
      ? membership?.orgId === orgId && hasCapability(membership, 'org:read')
      : platformAdmin;
  }
  if (within(path, '/admin/passes')) {
    return hasCapability(
      membership,
      path === '/admin/passes/new' ? 'passes:operate' : 'passes:read',
    );
  }
  if (within(path, '/admin/templates')) {
    const editing =
      path === '/admin/templates/upload' || /^\/admin\/templates\/[^/]+\/design$/.test(path);
    if (!hasCapability(membership, 'templates:read')) return false;
    if (editing) return hasCapability(membership, 'templates:author');
    // Pass issuance can read templates without granting access to template management.
    return (
      hasCapability(membership, 'templates:author') ||
      hasCapability(membership, 'templates:review') ||
      hasCapability(membership, 'templates:publish')
    );
  }
  if (within(path, '/admin/connections')) {
    return hasCapability(
      membership,
      path === '/admin/connections/new' ? 'integrations:manage' : 'integrations:read',
    );
  }
  if (within(path, '/admin/scanning')) return hasCapability(membership, 'scanning:read');
  if (within(path, '/admin/messages')) {
    return hasCapability(
      membership,
      path === '/admin/messages/new' ? 'messages:manage' : 'messages:read',
    );
  }
  if (within(path, '/admin/test-inbox')) return hasCapability(membership, 'passes:read');
  return false;
}

/** Routes the session guard skips: the sign-in page. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/login';
}

export async function requireSession(
  queryClient: QueryClient,
  next: string,
): Promise<AuthedSession> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (!session.authenticated) {
    // Home is no destination: signing in picks it (the console for admins, My passes otherwise).
    const target = safeNext(next);
    throw redirect({ to: '/login', search: target === '/' ? {} : { next: target } });
  }
  return session;
}

/** Admit a platform admin or a principal with at least one active organization membership. */
export async function requireAdminConsole(
  queryClient: QueryClient,
  next: string,
): Promise<AuthedSession> {
  const session = await requireSession(queryClient, next);
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

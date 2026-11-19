// Old console URLs (?orgId=, /admin/orgs/$id?view=workspace, /admin/identities) and where
// they open now. Kept so deep links and bookmarks keep working; see routes/admin/* legacy files.
import type { QueryClient } from '@tanstack/react-query';
import { notFound, redirect } from '@tanstack/react-router';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { canAccessAdminPath } from './guards.ts';
import { type AdminScope, orgPath, PLATFORM, platformPath, scopePath } from './scope.ts';
import { readRemembered, readTabScope } from './scope-store.ts';
import { isAdmin, membershipsQuery, sessionQuery } from './session.ts';

const TENANT =
  /^\/admin\/(passes|templates|blueprints|connections|messages|scanning|test-inbox)(\/|$)/;
const PLATFORM_ONLY = /^\/admin\/(orgs|users|status)(\/|$)/;

export interface LegacyContext {
  platformAdmin: boolean;
  /** Active memberships of the signed-in principal. */
  memberships: readonly OrgMembership[];
  /** The scope this tab has open, then the one last opened in any tab. */
  tab?: AdminScope | undefined;
  remembered?: AdminScope | undefined;
}

export interface LegacyTarget {
  to: string;
  search: Record<string, unknown>;
}

type Plan =
  | { kind: 'org'; rest: string; orgId?: string; detail: boolean }
  | { kind: 'platform'; rest: string }
  | { kind: 'either'; rest: string; preferPlatform: boolean };

function plan(path: string, search: Record<string, unknown>): Plan | undefined {
  const tenant = TENANT.exec(path);
  if (tenant) {
    const rest = path.slice('/admin'.length);
    // A detail page finds its owner and moves there itself (useResourceOrg).
    const detail = rest.split('/').length > 2;
    return { kind: 'org', rest, detail };
  }
  const org = /^\/admin\/orgs\/([^/]+)$/.exec(path);
  if (org?.[1] && (search.view === 'workspace' || search.confirmReplyTo !== undefined)) {
    try {
      return {
        kind: 'org',
        rest: '/settings',
        orgId: decodeURIComponent(org[1]),
        detail: false,
      };
    } catch {
      return undefined;
    }
  }
  if (PLATFORM_ONLY.test(path)) return { kind: 'platform', rest: path.slice('/admin'.length) };
  const identity = /^\/admin\/identities(\/.*)?$/.exec(path);
  if (identity) return { kind: 'platform', rest: `/wallet-accounts${identity[1] ?? ''}` };
  if (path === '/admin/settings')
    return { kind: 'either', rest: '/settings', preferPlatform: true };
  if (path === '/admin' || path === '/admin/audit' || path === '/admin/api-keys') {
    return { kind: 'either', rest: path.slice('/admin'.length), preferPlatform: false };
  }
  return undefined;
}

function explicitOrg(search: Record<string, unknown>): string | undefined {
  const value = search.orgId;
  const id = typeof value === 'number' ? String(value) : value;
  return typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : undefined;
}

function rememberedOrg(ctx: LegacyContext, rest: string, any: boolean): string | undefined {
  const member = (scope: AdminScope | undefined) =>
    scope?.kind === 'org' && ctx.memberships.some((m) => m.orgId === scope.orgId)
      ? scope.orgId
      : undefined;
  const allowed = ctx.memberships.filter((m) =>
    canAccessAdminPath(orgPath(m.orgId, rest), false, m),
  );
  return (
    member(ctx.tab) ??
    member(ctx.remembered) ??
    (allowed.length === 1 || (any && allowed.length > 0) ? allowed[0]?.orgId : undefined) ??
    (ctx.memberships.length === 1 ? ctx.memberships[0]?.orgId : undefined)
  );
}

function platformFirst(ctx: LegacyContext): boolean {
  if (!ctx.platformAdmin) return false;
  for (const scope of [ctx.tab, ctx.remembered]) {
    if (scope?.kind === 'platform') return true;
    if (scope?.kind === 'org' && ctx.memberships.some((m) => m.orgId === scope.orgId)) return false;
  }
  return true;
}

/**
 * The new URL for an old one; undefined when the path is not an old console URL. A choice that
 * needs the principal (several organizations, none remembered) goes to /admin's chooser with
 * the section to open.
 */
export function legacyAdminTarget(
  pathname: string,
  search: Record<string, unknown>,
  ctx: LegacyContext,
): LegacyTarget | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const step = plan(path, search);
  if (!step) return undefined;
  const { orgId: _org, view: _view, ...kept } = search;
  if (step.kind === 'platform') return { to: platformPath(step.rest), search: kept };
  const explicit = step.kind === 'org' ? (step.orgId ?? explicitOrg(search)) : explicitOrg(search);
  if (
    step.kind === 'either' &&
    !explicit &&
    (step.preferPlatform ? ctx.platformAdmin : platformFirst(ctx))
  ) {
    return { to: scopePath(PLATFORM, step.rest), search: kept };
  }
  const orgId = explicit ?? rememberedOrg(ctx, step.rest, step.kind === 'org' && step.detail);
  if (orgId) return { to: orgPath(orgId, step.rest), search: kept };
  if (step.kind === 'either' && ctx.platformAdmin)
    return { to: platformPath(step.rest), search: kept };
  return { to: '/admin', search: step.rest ? { next: step.rest } : {} };
}

/** A legacy route's beforeLoad: move to the new URL, replacing the old history entry. */
export async function redirectLegacy({
  context,
  location,
}: {
  context: { queryClient: QueryClient };
  location: { pathname: string; search: unknown };
}): Promise<never> {
  const session = await context.queryClient.ensureQueryData(sessionQuery);
  const userId = session.authenticated ? session.user.id : undefined;
  const grants = await context.queryClient.ensureQueryData(membershipsQuery);
  const target = legacyAdminTarget(
    location.pathname,
    (location.search ?? {}) as Record<string, unknown>,
    {
      platformAdmin: isAdmin(session),
      memberships: grants.items.filter((m) => m.userId === userId && m.revokedAt === null),
      tab: readTabScope(),
      remembered: readRemembered(),
    },
  );
  if (!target) throw notFound();
  throw redirect({ to: target.to, search: target.search, replace: true });
}

/** Legacy routes accept any search: links still pass their old parameters, which carry over. */
export const legacySearch = (raw: Record<string, unknown>): Record<string, unknown> => raw;

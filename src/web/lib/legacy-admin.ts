// Old console URLs (?orgId=, /admin/orgs/$id?view=workspace, /admin/identities) and where
// they open now. Kept so deep links and bookmarks keep working; see routes/admin/* legacy files.
import type { QueryClient } from '@tanstack/react-query';
import { notFound, redirect } from '@tanstack/react-router';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { currentPath } from './current-path.ts';
import { canAccessAdminPath } from './guards.ts';
import { canUseAllScope, listableMemberships } from './org-lists.ts';
import {
  type AdminScope,
  allPath,
  orgPath,
  PLATFORM,
  parseAdminPath,
  platformPath,
  scopePath,
} from './scope.ts';
import { readRemembered, readTabScope } from './scope-store.ts';
import { isAdmin, membershipsQuery, sessionQuery } from './session.ts';

const TENANT =
  /^\/admin\/(passes|templates|blueprints|connections|messages|scanning|test-inbox)(\/|$)/;
const NOT_A_RESOURCE =
  /^\/(passes\/(new|import|photos|change)|templates\/(new|upload)|connections\/(new|webhooks\/new)|messages\/new)$/;
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
  /** A detail link that named no organization: the page may move to the resource's owner. */
  findOwner?: true;
}

type Plan =
  | { kind: 'org'; rest: string; orgId?: string; detail: boolean }
  | { kind: 'platform'; rest: string }
  | { kind: 'either'; rest: string; preferPlatform: boolean };

function plan(path: string, search: Record<string, unknown>): Plan | undefined {
  const tenant = TENANT.exec(path);
  if (tenant) {
    const rest = path.slice('/admin'.length);
    // A detail page names a resource and moves to its owner itself (useResourceOrg). Lists,
    // creation and import pages name none: with several organizations, the user picks one.
    const detail = rest.split('/').length > 2 && !NOT_A_RESOURCE.test(rest);
    return { kind: 'org', rest, detail };
  }
  const org = /^\/admin\/orgs\/([^/]+)$/.exec(path);
  if (org?.[1] && (search.view === 'workspace' || search.confirmReplyTo !== undefined)) {
    let orgId: string;
    try {
      orgId = decodeURIComponent(org[1]);
    } catch {
      return undefined;
    }
    // A workspace link whose ?orgId= names another organization opens neither: only the record.
    if (search.orgId === undefined || search.orgId === orgId) {
      // The reply-to confirmation lives with the support contacts, on Brand and channels.
      const rest = search.confirmReplyTo !== undefined ? '/brand' : '/settings';
      return { kind: 'org', rest, orgId, detail: false };
    }
  }
  if (PLATFORM_ONLY.test(path)) return { kind: 'platform', rest: path.slice('/admin'.length) };
  const identity = /^\/admin\/identities(\/.*)?$/.exec(path);
  if (identity) return { kind: 'platform', rest: `/wallet-accounts${identity[1] ?? ''}` };
  if (path === '/admin/settings')
    return { kind: 'either', rest: '/settings', preferPlatform: true };
  if (path === '/admin' || path === '/admin/audit' || path === '/admin/api-keys') {
    // filterOrgId is the platform overview's and log's own filter.
    const preferPlatform = search.filterOrgId !== undefined;
    return { kind: 'either', rest: path.slice('/admin'.length), preferPlatform };
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
  context: LegacyContext,
): LegacyTarget | undefined {
  // A remembered or lone sandbox never reopens in admin; an orgId in the URL still does.
  const ctx = { ...context, memberships: listableMemberships(context.memberships) };
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const step = plan(path, search);
  if (!step) return undefined;
  const { orgId: _org, ...rest } = search;
  // view=workspace only chose the old org page's face; other pages' view (templates) stays.
  const { view: _view, ...withoutView } = rest;
  const kept = /^\/admin\/orgs\//.test(path) ? withoutView : rest;
  if (step.kind === 'platform') return { to: platformPath(step.rest), search: kept };
  const explicit = step.kind === 'org' ? (step.orgId ?? explicitOrg(search)) : explicitOrg(search);
  // The overview link reopens All when that was the last scope and it is still open to this person.
  if (
    path === '/admin' &&
    !explicit &&
    (ctx.tab ?? ctx.remembered)?.kind === 'all' &&
    canUseAllScope(ctx.memberships)
  ) {
    return { to: allPath('/passes'), search: kept };
  }
  if (
    step.kind === 'either' &&
    !explicit &&
    (step.preferPlatform ? ctx.platformAdmin : platformFirst(ctx))
  ) {
    return { to: scopePath(PLATFORM, step.rest), search: kept };
  }
  const detail = step.kind === 'org' && step.detail;
  const orgId = explicit ?? rememberedOrg(ctx, step.rest, detail);
  if (orgId) {
    const to = orgPath(orgId, step.rest);
    return detail && !explicit ? { to, search: kept, findOwner: true } : { to, search: kept };
  }
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
  const search = (location.search ?? {}) as Record<string, unknown>;
  // Platform pages open without waiting for (or failing on) organization grants.
  const platformOnly = plan(location.pathname.replace(/\/+$/, ''), search)?.kind === 'platform';
  const grants = platformOnly
    ? { items: [] }
    : await context.queryClient.ensureQueryData(membershipsQuery);
  const target = legacyAdminTarget(location.pathname, search, {
    platformAdmin: isAdmin(session),
    memberships: grants.items.filter((m) => m.userId === userId && m.revokedAt === null),
    tab: readTabScope(),
    remembered: readRemembered(),
  });
  if (!target) throw notFound();
  throw redirect({
    to: target.to,
    search: target.search,
    replace: true,
    ...(target.findOwner ? { state: (prev) => ({ ...prev, findOwner: true }) } : {}),
  });
}

/** Legacy routes accept any search: links still pass their old parameters, which carry over. */
export const legacySearch = (raw: Record<string, unknown>): Record<string, unknown> => raw;

/**
 * Links to an old URL from inside an organization carry it as ?orgId=, as the console did
 * before, so the href (and a new tab) opens the same organization.
 */
export const carryOrgScope = {
  middlewares: [
    ({
      search,
      next,
    }: {
      search: Record<string, unknown>;
      next: (search: Record<string, unknown>) => Record<string, unknown>;
    }) => {
      const result = next(search);
      // A link that sets orgId, even to undefined, chose its scope itself.
      if ('orgId' in result) return result;
      const scope = parseAdminPath(currentPath() ?? '').scope;
      return scope?.kind === 'org' ? { ...result, orgId: scope.orgId } : result;
    },
  ],
};

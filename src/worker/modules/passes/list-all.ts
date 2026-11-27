import type { PassFilter } from '../../../shared/contracts/pass-selection.ts';
import { resolveOrgTimeZone } from '../../../shared/time-zone.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { workbenchPinOf } from '../../platform/auth-workbench.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listMyOrgMemberships } from '../orgs/access.ts';
import { viewerOrgName } from '../orgs/personal-names.ts';
import { toSummary } from './detail.ts';
import { listFilterOf } from './find.ts';
import { countPasses, listPasses, type PassListFilter } from './repo-list.ts';
import { listPassBranches, pageLabels } from './repo-list-all.ts';
import type { Pass } from './repo-map.ts';

/** Organizations one list reads; more must be narrowed with `orgIds`. */
export const PASS_LIST_ORG_CAP = 50;

/** The organizations a person can read passes in: active, not a developer sandbox, with `passes:read`. */
export async function readablePassOrgs(ctx: ServiceContext, userId: string): Promise<string[]> {
  return (await listMyOrgMemberships(ctx, userId))
    .filter((m) => !m.testOnly && m.capabilities.includes('passes:read'))
    .map((m) => m.orgId);
}

async function sessionOrgs(
  ctx: ServiceContext,
  userId: string,
  requested: string[] | undefined,
): Promise<string[]> {
  const readable = await readablePassOrgs(ctx, userId);
  if (requested) {
    const allowed = new Set(readable);
    // One answer for an organization you cannot read and one that does not exist.
    if (!requested.every((id) => allowed.has(id)))
      throw new ForbiddenError(
        'You cannot read passes in one of these organizations.',
        'ORG_FORBIDDEN',
      );
    return [...new Set(requested)];
  }
  if (readable.length > PASS_LIST_ORG_CAP)
    throw new ValidationError(
      `You can read passes in more than ${PASS_LIST_ORG_CAP} organizations. Filter by organization.`,
      [],
      'ORG_SCOPE_TOO_WIDE',
    );
  return readable;
}

/** The list (and optional count) of `orgId=all`: a session's readable organizations, or every one for a global key. */
export async function listPassesAcross(
  ctx: ServiceContext,
  auth: AuthContext,
  scope: { mode: PassListFilter['mode']; filter: PassFilter; orgIds: string[] | undefined },
  page: { cursor: string | undefined; limit: number; count: boolean },
) {
  let orgIds: string[] | undefined;
  let viewerId = '';
  if (auth.kind === 'session') {
    if (workbenchPinOf(auth))
      throw new ForbiddenError('A Workbench token reads one organization.', 'ORG_FORBIDDEN');
    orgIds = await sessionOrgs(ctx, auth.userId, scope.orgIds);
    viewerId = auth.userId;
  } else if (auth.kind === 'api_key' && auth.orgId === null) {
    orgIds = scope.orgIds;
  } else {
    throw new ForbiddenError(
      'A global API key is required for platform-wide pass lists.',
      'ORG_FORBIDDEN',
    );
  }
  ctx.log.info('passes.list_across', {
    orgCount: orgIds?.length ?? null,
    code: 'PASSES_LIST_ACROSS',
  });
  const list = listFilterOf(ctx, { orgId: null, mode: scope.mode }, scope.filter);
  if (!list || orgIds?.length === 0)
    return { items: [], nextCursor: null, ...(page.count ? { count: 0 } : {}) };
  const read = { ...list, ...(page.cursor ? { cursor: page.cursor } : {}), limit: page.limit };
  const found = orgIds
    ? await listPassBranches(ctx.env.DB, orgIds, read)
    : await listPasses(ctx.env.DB, read);
  const items = await withLabels(ctx, found.items, viewerId);
  const counted = orgIds ? { ...list, orgIds } : list;
  return {
    items,
    nextCursor: found.nextCursor,
    ...(page.count ? { count: await countPasses(ctx.env.DB, counted) } : {}),
  };
}

async function withLabels(ctx: ServiceContext, passes: Pass[], viewerId: string) {
  if (passes.length === 0) return [];
  const labels = await pageLabels(
    ctx.env.DB,
    [...new Set(passes.map((p) => p.orgId))],
    [...new Set(passes.map((p) => p.templateId))],
  );
  const orgs = new Map(labels.orgs.map((o) => [o.id, o]));
  const templates = new Map(labels.templates.map((t) => [t.id, t.name]));
  return passes.map((p) => {
    const org = orgs.get(p.orgId);
    return {
      ...toSummary(p),
      ...(org ? { orgName: viewerOrgName(org, viewerId) } : {}),
      templateName: templates.get(p.templateId) ?? p.templateId,
      timeZone: resolveOrgTimeZone(org?.time_zone),
    };
  });
}

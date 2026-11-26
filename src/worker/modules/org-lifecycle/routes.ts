import { CursorQuerySchema } from '../../../shared/contracts/common.ts';
import {
  ClosedOrgListSchema,
  CloseOrgSchema,
  OrgExportDownloadParamsSchema,
  OrgExportDownloadQuerySchema,
  OrgExportLinkSchema,
  OrgExportListSchema,
  OrgExportParamsSchema,
  OrgExportStartedSchema,
  OrgLifecycleParamsSchema,
  OrgLifecycleSchema,
} from '../../../shared/contracts/org-lifecycle.ts';
import { requireAdmin, requireStrictSession } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireStepUp, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { requireNotPersonalFor } from '../orgs/personal-guard.ts';
import { authOf, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { requestExport } from './export-start.ts';
import type { LifecycleActor } from './repo.ts';
import {
  closeOrg,
  exportLink,
  listClosed,
  listExports,
  openExport,
  readLifecycle,
  reopenOrg,
} from './service.ts';

type C = Parameters<typeof authOf>[0];

/**
 * The signed-in caller: a platform admin session, else an org admin's. The service repeats the fence in SQL
 * at the write, so a role removed a moment ago stops the request. No API key reaches these routes: an export
 * hands over every holder's data, so it needs a person (WP2's `x-human-only` is not on main yet).
 */
function callerOf(c: C): LifecycleActor {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  const base = { userId: auth.userId, sessionId: auth.sessionId };
  return auth.roles.includes('admin') ? { kind: 'platform', ...base } : { kind: 'owner', ...base };
}

/** A platform admin reads or reopens a personal org only if it is hers. */
async function platformCallerOwnsPersonal(c: C, next: () => Promise<void>) {
  const caller = callerOf(c);
  if (caller.kind === 'platform')
    await requireNotPersonalFor(c.env.DB, c.req.param('orgId') ?? '', caller.userId);
  await next();
}

/** Mount at /api/v1/orgs. Platform: close, reopen, read, export. Org admin: close with the slug, read, export. */
export const orgLifecycleRoutes = createRouter();
guard(orgLifecycleRoutes, requireTenantSession);
orgLifecycleRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});
orgLifecycleRoutes.use('/:orgId/reopen', requireAdmin);
orgLifecycleRoutes.use('/:orgId/reopen', platformCallerOwnsPersonal);
orgLifecycleRoutes.use('/:orgId/lifecycle', platformCallerOwnsPersonal);
// Closing an org is a strong sign-in with no email-link grace, so the refusal names Polaris ID.
orgLifecycleRoutes.use('/:orgId/close', requireStrictSession);
// Close, reopen and export are the actions that end or empty an org: a recent sign-in.
for (const path of [
  '/:orgId/close',
  '/:orgId/reopen',
  '/:orgId/exports',
  '/:orgId/exports/:exportId/link',
])
  orgLifecycleRoutes.post(path, requireStepUp(STEP_UP_SECONDS));

register(
  orgLifecycleRoutes,
  'org-lifecycle',
  {
    method: 'get',
    path: '/{orgId}/lifecycle',
    summary: 'Read the open or closed state of an organization',
    params: OrgLifecycleParamsSchema,
    response: OrgLifecycleSchema,
  },
  async (c) =>
    c.json(await readLifecycle(serviceContext(c), c.req.valid('param').orgId, callerOf(c))),
);

register(
  orgLifecycleRoutes,
  'org-lifecycle',
  {
    method: 'post',
    path: '/{orgId}/close',
    summary: 'Close an organization: read-only, passes stop updating, 30 days to export',
    params: OrgLifecycleParamsSchema,
    body: CloseOrgSchema.partial(),
    response: OrgLifecycleSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const { orgId } = c.req.valid('param');
    const caller = callerOf(c);
    if (caller.kind === 'platform')
      return c.json(await closeOrg(ctx, requestActor(c), orgId, { ...caller }));
    const authority = await tenantAuthorityOf(ctx, authOf(c), orgId, 'org:manage');
    if (authority.kind !== 'session') throw new UnauthenticatedError();
    return c.json(
      await closeOrg(
        ctx,
        requestActor(c),
        orgId,
        { kind: 'owner', authority },
        c.req.valid('json').confirmSlug,
      ),
    );
  },
);

register(
  orgLifecycleRoutes,
  'org-lifecycle',
  {
    method: 'post',
    path: '/{orgId}/reopen',
    summary: 'Reopen a closed organization inside its 30 days',
    params: OrgLifecycleParamsSchema,
    response: OrgLifecycleSchema,
  },
  async (c) => {
    const caller = callerOf(c);
    return c.json(
      await reopenOrg(serviceContext(c), requestActor(c), c.req.valid('param').orgId, caller),
    );
  },
);

register(
  orgLifecycleRoutes,
  'org-lifecycle',
  {
    method: 'get',
    path: '/{orgId}/exports',
    summary: 'List organization exports',
    params: OrgLifecycleParamsSchema,
    query: CursorQuerySchema,
    response: OrgExportListSchema,
  },
  async (c) =>
    c.json({
      items: await listExports(serviceContext(c), c.req.valid('param').orgId, callerOf(c)),
      nextCursor: null,
    }),
);

register(
  orgLifecycleRoutes,
  'org-lifecycle',
  {
    method: 'post',
    path: '/{orgId}/exports',
    summary: 'Export everything the organization holds',
    params: OrgLifecycleParamsSchema,
    response: OrgExportStartedSchema,
    status: 202,
  },
  async (c) =>
    c.json(
      await requestExport(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').orgId,
        callerOf(c),
        authOf(c).mode,
      ),
      202,
    ),
);

register(
  orgLifecycleRoutes,
  'org-lifecycle',
  {
    method: 'post',
    path: '/{orgId}/exports/{exportId}/link',
    summary: 'Get a download link for a finished export, good for 1 hour, one download',
    params: OrgExportParamsSchema,
    response: OrgExportLinkSchema,
  },
  async (c) => {
    const { orgId, exportId } = c.req.valid('param');
    return c.json(
      await exportLink(serviceContext(c), requestActor(c), orgId, exportId, callerOf(c)),
    );
  },
);

/** Mount at /api/v1/org-exports. The link is the credential: a MAC over the org, the export and the expiry. */
export const orgExportDownloadRoutes = createRouter();
register(
  orgExportDownloadRoutes,
  'org-lifecycle',
  {
    method: 'get',
    path: '/{exportId}/download',
    summary: 'Download an organization export with its link',
    params: OrgExportDownloadParamsSchema,
    query: OrgExportDownloadQuerySchema,
  },
  async (c) => {
    const { exportId } = c.req.valid('param');
    const { exp, sig } = c.req.valid('query');
    const file = await openExport(serviceContext(c), exportId, exp, sig);
    return new Response(file.body, {
      headers: {
        'content-type': 'application/zip',
        'content-length': String(file.size),
        'content-disposition': `attachment; filename="${file.name}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);

/** Mount at /api/v1/platform: the closed organizations, soonest purge first. */
export const orgClosedRoutes = createRouter();
orgClosedRoutes.use('*', requireAdmin);
register(
  orgClosedRoutes,
  'org-lifecycle',
  {
    method: 'get',
    path: '/closed-orgs',
    summary: 'List closed organizations',
    query: CursorQuerySchema,
    response: ClosedOrgListSchema,
  },
  async (c) => c.json({ items: await listClosed(serviceContext(c)), nextCursor: null }),
);

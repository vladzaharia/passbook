import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  CreateScanZoneSchema,
  ScanZoneListQuerySchema,
  ScanZoneListSchema,
  ScanZoneSchema,
  UpdateScanZoneSchema,
} from '../../../shared/contracts/scan-access.ts';
import { currentUserId } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { zoneTarget } from './repo-zones.ts';
import { archiveZone, createZone, listZones, updateZone } from './zones.ts';

/** Console zones: /api/v1/scan-zones. Zones are org data, shared by both modes. */
export const scanZonesRoutes = createRouter();
guard(scanZonesRoutes, requireTenantSession);
scanZonesRoutes.use('*', limitBody(16 * 1024));

const TAG = 'scan-zones';

/** The zone's own org decides the authority; a zone of an org the user is not in is a 404. */
async function manage(c: C, id: string) {
  const ctx = serviceContext(c);
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  const zone = await zoneTarget(ctx.env.DB, id);
  if (!zone || !(await getOrgAccess(ctx, auth.userId, zone.orgId)))
    throw new NotFoundError('Zone not found.', 'ZONE_NOT_FOUND');
  const authority = await tenantAuthorityOf(ctx, auth, zone.orgId, 'scanning:manage');
  if (authority.kind !== 'session') throw new UnauthenticatedError();
  return { ctx, orgId: zone.orgId, authority };
}

register(
  scanZonesRoutes,
  TAG,
  {
    method: 'get',
    path: '/',
    summary: 'List zones',
    query: ScanZoneListQuerySchema,
    response: ScanZoneListSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const query = c.req.valid('query');
    if (!(await getOrgAccess(ctx, auth.userId, query.orgId)))
      return c.json({ items: [], nextCursor: null });
    const authority = await tenantAuthorityOf(ctx, auth, query.orgId, 'scanning:read');
    if (authority.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await listZones(ctx, authority, query));
  },
);
register(
  scanZonesRoutes,
  TAG,
  {
    method: 'post',
    path: '/',
    summary: 'Create a zone',
    body: CreateScanZoneSchema,
    status: 201,
    response: ScanZoneSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const input = c.req.valid('json');
    if (!(await getOrgAccess(ctx, auth.userId, input.orgId)))
      throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
    const authority = await tenantAuthorityOf(ctx, auth, input.orgId, 'scanning:manage');
    if (authority.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await createZone(ctx, currentUserId(c), input, authority), 201);
  },
);
register(
  scanZonesRoutes,
  TAG,
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Edit a zone',
    params: IdParamSchema,
    body: UpdateScanZoneSchema,
    response: ScanZoneSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const { ctx, orgId, authority } = await manage(c, id);
    return c.json(
      await updateZone(ctx, currentUserId(c), orgId, id, c.req.valid('json'), authority),
    );
  },
);
for (const [path, archived, summary] of [
  ['/{id}/archive', true, 'Archive a zone and the zones below it'],
  ['/{id}/restore', false, 'Restore a zone and the zones below it'],
] as const)
  register(
    scanZonesRoutes,
    TAG,
    { method: 'post', path, summary, params: IdParamSchema, response: ScanZoneSchema },
    async (c) => {
      const id = c.req.valid('param').id;
      const { ctx, orgId, authority } = await manage(c, id);
      return c.json(await archiveZone(ctx, currentUserId(c), orgId, id, archived, authority));
    },
  );

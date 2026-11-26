import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  CreateScanZoneSchema,
  ScanVisitsResetSchema,
  ScanZoneListQuerySchema,
  ScanZoneListSchema,
  ScanZoneSchema,
  UpdateScanZoneSchema,
} from '../../../shared/contracts/scan-access.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { assertSharedWrite } from '../orgs/shared-write.ts';
import { type C, tenantAuthorityOf } from '../passes/http.ts';
import { resetVisits } from './access-visits.ts';
import { orgOf } from './key-credentials.ts';
import { passTarget } from './repo-access.ts';
import { zoneTarget } from './repo-zones.ts';
import { archiveZone, createZone, listZones, updateZone } from './zones.ts';

type Router = ReturnType<typeof createRouter>;
const TAG = 'scan-zones';
const FEATURE = 'scanning.devices' as const;
/** No `capability` or `feature`: a caller outside the org gets an empty page, so the handler does not always prove either. */
const READ = { scope: 'scan-setup:read' } as const;
const WRITE = { scope: 'scanning:write', capability: 'scanning:manage', feature: FEATURE } as const;

const noOrg = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
const noZone = () => new NotFoundError('Zone not found.', 'ZONE_NOT_FOUND');

/**
 * The caller for an org: a console session by membership, or a key under its own principal. A key of
 * another org finds no such org. Zones are org-wide, so a write key must be live (the grant re-checks it).
 */
async function caller(
  c: C,
  orgId: string,
  capability: 'scanning:read' | 'scanning:manage',
  missing: () => NotFoundError,
) {
  const ctx = serviceContext(c);
  const auth = c.var.auth as SessionAuth | ApiKeyAuth | undefined;
  if (auth?.kind === 'api_key') {
    if (auth.orgId !== orgId) throw missing();
    return {
      ctx,
      auth,
      actorId: auth.keyId,
      authority: await tenantAuthorityOf(ctx, auth, orgId, capability),
    };
  }
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (!(await getOrgAccess(ctx, auth.userId, orgId))) throw missing();
  return {
    ctx,
    auth,
    actorId: auth.userId,
    authority: await tenantAuthorityOf(ctx, auth, orgId, capability),
  };
}

async function ofZone(c: C, id: string) {
  const zone = await zoneTarget(serviceContext(c).env.DB, id);
  if (!zone) throw noZone();
  const w = await caller(c, zone.orgId, 'scanning:manage', noZone);
  await assertSharedWrite(w.ctx, w.authority, zone.orgId, 'zones');
  return { orgId: zone.orgId, ...w };
}

export function registerZoneRoutes(router: Router): void {
  router.use('*', limitBody(16 * 1024));
  register(
    router,
    TAG,
    {
      method: 'get',
      path: '/',
      summary: 'List zones',
      auth: READ,
      query: ScanZoneListQuerySchema,
      response: ScanZoneListSchema,
    },
    async (c) => {
      const given = c.req.valid('query');
      const auth = c.var.auth;
      // One decision for every scan list that takes an org (see `orgOf`).
      const orgId = orgOf(auth, given.orgId);
      const query = { ...given, orgId };
      let w: Awaited<ReturnType<typeof caller>>;
      try {
        w = await caller(c, orgId, 'scanning:read', noOrg);
      } catch (e) {
        if (e instanceof NotFoundError) return c.json({ items: [], nextCursor: null });
        throw e;
      }
      return c.json(await listZones(w.ctx, w.authority, query, w.auth.mode));
    },
  );
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/',
      summary: 'Create a zone',
      auth: WRITE,
      body: CreateScanZoneSchema,
      status: 201,
      response: ScanZoneSchema,
    },
    async (c) => {
      const input = c.req.valid('json');
      const w = await caller(c, input.orgId, 'scanning:manage', noOrg);
      return c.json(await createZone(w.ctx, w.actorId, input, w.authority, w.auth.mode), 201);
    },
  );
  register(
    router,
    TAG,
    {
      method: 'patch',
      path: '/{id}',
      summary: 'Edit a zone',
      auth: WRITE,
      params: IdParamSchema,
      body: UpdateScanZoneSchema,
      response: ScanZoneSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const w = await ofZone(c, id);
      return c.json(
        await updateZone(
          w.ctx,
          w.actorId,
          w.orgId,
          id,
          c.req.valid('json'),
          w.authority,
          w.auth.mode,
        ),
      );
    },
  );
  for (const [path, archived, summary] of [
    ['/{id}/archive', true, 'Archive a zone and the zones below it'],
    ['/{id}/restore', false, 'Restore a zone and the zones below it'],
  ] as const)
    register(
      router,
      TAG,
      {
        method: 'post',
        path,
        summary,
        auth: WRITE,
        params: IdParamSchema,
        response: ScanZoneSchema,
      },
      async (c) => {
        const id = c.req.valid('param').id;
        const w = await ofZone(c, id);
        return c.json(
          await archiveZone(w.ctx, w.actorId, w.orgId, id, archived, w.authority, w.auth.mode),
        );
      },
    );
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/visits/{id}/reset',
      summary: 'Reset a pass’s visits',
      auth: WRITE,
      params: IdParamSchema,
      response: ScanVisitsResetSchema,
    },
    async (c) => {
      const passId = c.req.valid('param').id;
      const pass = await passTarget(serviceContext(c).env.DB, passId);
      const missing = () => new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
      if (!pass) throw missing();
      const w = await caller(c, pass.orgId, 'scanning:manage', missing);
      return c.json(await resetVisits(w.ctx, w.actorId, passId, w.authority));
    },
  );
}

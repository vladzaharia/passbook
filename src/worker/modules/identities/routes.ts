import { createMiddleware } from 'hono/factory';
import {
  ApnsProbeResultSchema,
  IdentityListQuerySchema,
  IdentityListSchema,
  IdentitySchema,
  IdParamSchema,
  OkSchema,
  OrgIdentityListSchema,
  PushKeyInputSchema,
  RotateIdentitySchema,
  UpdateIdentitySchema,
  UploadIdentitySchema,
} from '../../../shared/contracts/index.ts';
import { bearerOf, requireAdmin, requireCaller } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { probeApns } from './apns-probe.ts';
import { removePushKey, setPushKey } from './push-key-service.ts';
import { registerManagedRoutes } from './routes-managed.ts';
import {
  deleteIdentity,
  getIdentity,
  listIdentities,
  listOrgIdentities,
  rotateIdentity,
  updateIdentity,
  uploadIdentity,
} from './service.ts';

export const identitiesRoutes = createRouter();

const isOrgList = (c: Parameters<typeof requireAdmin>[0]) => !!c.req.query('orgId');
const platformKeyList = requireCaller({ platform: 'platform:identities', key: true });

/**
 * Two reads serve a member of the organization as well as a platform admin, so they keep a dispatching guard:
 * `orgId` and the certificate history are org reads, checked in the handler. The list without `orgId` is the platform's:
 * a Bearer key goes through the platform gate (a Platform key with `platform:identities` or `platform:read`), a
 * session through `requireAdmin`. Every other route declares `{ platform: 'platform:identities' }` itself; the
 * certificate, push-key and rotate writes ask a session for a recent sign-in.
 */
identitiesRoutes.get(
  '/',
  createMiddleware<AppBindings>((c, next) =>
    isOrgList(c)
      ? requireTenantSession(c, next)
      : bearerOf(c)
        ? platformKeyList(c, next)
        : requireAdmin(c, next),
  ),
);
identitiesRoutes.get('/:id/certificates', requireTenantSession);

register(
  identitiesRoutes,
  'identities',
  {
    method: 'get',
    path: '/',
    summary: 'List Apple identities',
    query: IdentityListQuerySchema,
    response: IdentityListSchema.or(OrgIdentityListSchema),
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    const auth = c.var.auth;
    // A platform admin reads the full record of any organization's identities. A member reads only
    // their own organization's, in the narrower member view.
    if (query.orgId && !(auth?.kind === 'session' && auth.roles.includes('admin'))) {
      if (auth?.kind !== 'session') throw new UnauthenticatedError();
      const authority = await tenantAuthorityOf(ctx, auth, query.orgId, 'org:read');
      if (authority.kind !== 'session') throw new ForbiddenError();
      return c.json(await listOrgIdentities(ctx, { ...query, orgId: query.orgId }));
    }
    return c.json(await listIdentities(ctx, query));
  },
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'post',
    path: '/',
    auth: { platform: 'platform:identities', key: true, stepUp: { maxAgeSec: STEP_UP_SECONDS } },
    summary: 'Upload an Apple identity',
    body: UploadIdentitySchema,
    status: 201,
    response: IdentitySchema,
  },
  async (c) =>
    c.json(await uploadIdentity(serviceContext(c), requestActor(c), c.req.valid('json')), 201),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'get',
    path: '/{id}',
    auth: { platform: 'platform:identities', key: true },
    summary: 'Get an Apple identity',
    params: IdParamSchema,
    response: IdentitySchema,
  },
  async (c) => c.json(await getIdentity(serviceContext(c), c.req.valid('param').id)),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'patch',
    path: '/{id}',
    auth: {
      platform: 'platform:identities',
      // Refused unless provably not choosing the default (P3: same act as POST /platform/apple/identities/:id/default).
      key: { unless: (_c, body) => body === null || body.isDefault !== undefined },
    },
    summary: 'Update an Apple identity',
    params: IdParamSchema,
    body: UpdateIdentitySchema,
    response: IdentitySchema,
  },
  async (c) =>
    c.json(
      await updateIdentity(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'delete',
    path: '/{id}',
    auth: { platform: 'platform:identities' },
    summary: 'Delete an Apple identity',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    await deleteIdentity(serviceContext(c), requestActor(c), c.req.valid('param').id);
    return c.json({ ok: true });
  },
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'post',
    path: '/{id}/rotate',
    auth: { platform: 'platform:identities', key: true, stepUp: { maxAgeSec: STEP_UP_SECONDS } },
    summary: 'Replace the certificate and key of an Apple identity',
    params: IdParamSchema,
    body: RotateIdentitySchema,
    response: IdentitySchema,
  },
  async (c) =>
    c.json(
      await rotateIdentity(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'post',
    path: '/{id}/apns-check',
    auth: { platform: 'platform:identities', key: true },
    summary: 'Probe APNs with the identity certificate using a dummy token',
    params: IdParamSchema,
    response: ApnsProbeResultSchema,
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_REFRESH', `apns-check:${c.req.valid('param').id}`);
    return c.json(await probeApns(serviceContext(c), requestActor(c), c.req.valid('param').id));
  },
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'put',
    path: '/{id}/push-key',
    auth: { platform: 'platform:identities', key: true, stepUp: { maxAgeSec: STEP_UP_SECONDS } },
    summary: 'Set or replace the APNs push key (.p8) of the identity team',
    params: IdParamSchema,
    body: PushKeyInputSchema,
    response: IdentitySchema,
  },
  async (c) =>
    c.json(
      await setPushKey(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'delete',
    path: '/{id}/push-key',
    auth: { platform: 'platform:identities', key: true },
    summary: 'Remove the APNs push key of the identity team',
    params: IdParamSchema,
    response: IdentitySchema,
  },
  async (c) =>
    c.json(await removePushKey(serviceContext(c), requestActor(c), c.req.valid('param').id)),
);

registerManagedRoutes(identitiesRoutes);

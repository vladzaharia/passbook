import type { Context } from 'hono';
import type { z } from 'zod';
import {
  ApnsProbeResultSchema,
  IdentityListSchema,
  IdentitySchema,
  IdParamSchema,
  OkSchema,
  RotateIdentitySchema,
  UpdateIdentitySchema,
  UploadIdentitySchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor, valid } from '../audit/http.ts';
import { probeApns } from './apns-probe.ts';
import {
  deleteIdentity,
  getIdentity,
  listIdentities,
  rotateIdentity,
  updateIdentity,
  uploadIdentity,
} from './service.ts';

export const identitiesRoutes = createRouter();
guard(identitiesRoutes, requireAdmin);

type Ctx = Context<AppBindings>;
const idOf = (c: Ctx) => valid<{ id: string }>(c, 'param').id;

register(
  identitiesRoutes,
  'identities',
  { method: 'get', path: '/', summary: 'List Apple identities', response: IdentityListSchema },
  async (c: Ctx) => c.json(await listIdentities(serviceContext(c))),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'post',
    path: '/',
    summary: 'Upload an Apple identity',
    body: UploadIdentitySchema,
    status: 201,
    response: IdentitySchema,
  },
  async (c: Ctx) =>
    c.json(
      await uploadIdentity(
        serviceContext(c),
        requestActor(c),
        valid<z.infer<typeof UploadIdentitySchema>>(c, 'json'),
      ),
      201,
    ),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get an Apple identity',
    params: IdParamSchema,
    response: IdentitySchema,
  },
  async (c: Ctx) => c.json(await getIdentity(serviceContext(c), idOf(c))),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update an Apple identity',
    params: IdParamSchema,
    body: UpdateIdentitySchema,
    response: IdentitySchema,
  },
  async (c: Ctx) =>
    c.json(
      await updateIdentity(
        serviceContext(c),
        requestActor(c),
        idOf(c),
        valid<z.infer<typeof UpdateIdentitySchema>>(c, 'json'),
      ),
    ),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete an Apple identity',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c: Ctx) => {
    await deleteIdentity(serviceContext(c), requestActor(c), idOf(c));
    return c.json({ ok: true });
  },
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'post',
    path: '/{id}/rotate',
    summary: 'Replace the certificate and key of an Apple identity',
    params: IdParamSchema,
    body: RotateIdentitySchema,
    response: IdentitySchema,
  },
  async (c: Ctx) =>
    c.json(
      await rotateIdentity(
        serviceContext(c),
        requestActor(c),
        idOf(c),
        valid<z.infer<typeof RotateIdentitySchema>>(c, 'json'),
      ),
    ),
);
register(
  identitiesRoutes,
  'identities',
  {
    method: 'post',
    path: '/{id}/apns-check',
    summary: 'Probe APNs with the identity certificate using a dummy token',
    params: IdParamSchema,
    response: ApnsProbeResultSchema,
  },
  async (c: Ctx) => {
    await enforceRateLimit(c.env, 'RL_REFRESH', `apns-check:${idOf(c)}`);
    return c.json(await probeApns(serviceContext(c), requestActor(c), idOf(c)));
  },
);

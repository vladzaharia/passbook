import { z } from 'zod';
import {
  BindPassConnectionSchema,
  DiffQuerySchema,
  IdParamSchema,
  OkSchema,
  PassActionResponseSchema,
  PassDetailSchema,
  PassListQuerySchema,
  PassListSchema,
  RefreshPassResponseSchema,
  ResendEmailSchema,
  RotateLinkResponseSchema,
} from '../../../shared/contracts/index.ts';
import { strictEmail } from '../../../shared/email.ts';
import { methodScope, modeOf, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { defaultBodyLimit } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { registerEventRoutes } from '../events/routes.ts';
import { bindPassConnection } from './connection-bind.ts';
import { diffVersions, getPassDetail, getVersionDetail } from './detail.ts';
import { actorFor, assertOrg, orgScopeOf, passScopeOf, svc } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { registerRemoveRoutes } from './remove-routes.ts';
import { registerAssetRoutes } from './routes-assets.ts';
import { registerBulkRoutes } from './routes-bulk.ts';
import { registerCheckInRoutes } from './routes-check-in.ts';
import { registerMemberPhotoRoutes } from './routes-member-photo.ts';
import { registerWriteRoutes } from './routes-write.ts';
import {
  deletePass,
  listPassSummaries,
  requestRefresh,
  resendEmail,
  rotateLink,
  unvoidPass,
  voidPass,
} from './service.ts';

export const passesRoutes = createRouter({ bodyLimit: false });
/** Image overrides have their own cap (routes-assets.ts). */
passesRoutes.use('*', defaultBodyLimit(/\/(?:assets\/[^/]+|member-photo)$/));
guard(
  passesRoutes,
  requireApiKeyOrAdmin(methodScope({ read: 'passes:read', write: 'passes:write' })),
);

register(
  passesRoutes,
  'passes',
  {
    method: 'get',
    path: '/',
    summary: 'List passes',
    query: PassListQuerySchema,
    response: PassListSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    if (q.orgId) assertOrg(c, q.orgId);
    const holderEmail = q.holderEmail ? strictEmail(q.holderEmail) : undefined;
    if (q.holderEmail && !holderEmail) return c.json({ items: [], nextCursor: null });
    return c.json(
      await listPassSummaries(svc(c), {
        orgId: orgScopeOf(c) ?? q.orgId,
        mode: modeOf(c.var.auth),
        ...(q.templateId ? { templateId: q.templateId } : {}),
        ...(q.connectionId ? { connectionId: q.connectionId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(holderEmail ? { holderEmail } : {}),
        ...(q.holderState ? { holderState: q.holderState } : {}),
        ...(q.onDevice !== undefined ? { onDevice: q.onDevice } : {}),
        ...(q.q ? { q: q.q } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit: q.limit,
      }),
    );
  },
);

register(
  passesRoutes,
  'passes',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get a pass',
    params: IdParamSchema,
    response: PassDetailSchema,
  },
  async (c) => {
    const detail = await getPassDetail(svc(c), c.req.valid('param').id, passScopeOf(c));
    return c.json(detail, 200, { etag: `"${detail.version}"` });
  },
);

register(
  passesRoutes,
  'passes',
  {
    method: 'put',
    path: '/{id}/connection',
    summary: 'Bind a pass to a connection ref, or unbind it',
    params: IdParamSchema,
    body: BindPassConnectionSchema,
    response: PassDetailSchema,
  },
  async (c) => {
    const detail = await bindPassConnection(
      svc(c),
      actorFor(c),
      c.req.valid('param').id,
      c.req.valid('json'),
      passScopeOf(c),
    );
    return c.json(detail, 200, { etag: `"${detail.version}"` });
  },
);

register(
  passesRoutes,
  'passes',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete a pass',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    await deletePass(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c));
    return c.json({ ok: true });
  },
);

for (const [path, summary, action] of [
  ['/{id}/void', 'Void a pass', voidPass],
  ['/{id}/unvoid', 'Unvoid a pass', unvoidPass],
] as const) {
  register(
    passesRoutes,
    'passes',
    { method: 'post', path, summary, params: IdParamSchema, response: PassActionResponseSchema },
    async (c) => c.json(await action(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c))),
  );
}

register(
  passesRoutes,
  'passes',
  {
    method: 'post',
    path: '/{id}/refresh',
    summary: 'Rebuild from the connection and re-push',
    params: IdParamSchema,
    status: 202,
    response: RefreshPassResponseSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const pass = await getPassForWrite(svc(c).env.DB, id, passScopeOf(c));
    const { requestedAt } = await requestRefresh(svc(c), id, actorFor(c), {
      orgId: pass.orgId,
      mode: pass.mode,
      version: pass.version,
      linkGeneration: pass.linkGeneration,
      status: pass.status,
      connectionId: pass.connectionId,
      externalRef: pass.externalRef,
    });
    return c.json({ accepted: true as const, requestedAt }, 202);
  },
);

register(
  passesRoutes,
  'passes',
  {
    method: 'post',
    path: '/{id}/rotate-link',
    summary: 'Rotate the download link',
    params: IdParamSchema,
    response: RotateLinkResponseSchema,
  },
  async (c) =>
    c.json(await rotateLink(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c))),
);

register(
  passesRoutes,
  'passes',
  {
    method: 'post',
    path: '/{id}/resend-email',
    summary: 'Email the pass to the holder',
    params: IdParamSchema,
    body: ResendEmailSchema,
    status: 202,
    response: OkSchema,
  },
  async (c) => {
    await resendEmail(
      svc(c),
      actorFor(c),
      c.req.valid('param').id,
      c.req.valid('json'),
      passScopeOf(c),
    );
    return c.json({ ok: true as const }, 202);
  },
);

register(
  passesRoutes,
  'passes',
  {
    method: 'get',
    path: '/{id}/versions/{version}',
    summary: 'A retained version, for rendering',
    params: IdParamSchema.extend({ version: z.coerce.number().int() }),
    response: PassDetailSchema,
  },
  async (c) => {
    const p = c.req.valid('param');
    return c.json(await getVersionDetail(svc(c), p.id, p.version, passScopeOf(c)));
  },
);

register(
  passesRoutes,
  'passes',
  {
    method: 'get',
    path: '/{id}/diff',
    summary: 'Diff two versions',
    params: IdParamSchema,
    query: DiffQuerySchema,
    response: z.object({
      changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
    }),
  },
  async (c) => {
    const q = c.req.valid('query');
    return c.json(
      await diffVersions(svc(c), c.req.valid('param').id, q.from, q.to, passScopeOf(c)),
    );
  },
);

registerWriteRoutes(passesRoutes);
registerAssetRoutes(passesRoutes);
registerMemberPhotoRoutes(passesRoutes);
registerCheckInRoutes(passesRoutes);
registerBulkRoutes(passesRoutes);
registerEventRoutes(passesRoutes);
registerRemoveRoutes(passesRoutes);

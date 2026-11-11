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
  RotateLinkResponseSchema,
} from '../../../shared/contracts/index.ts';
import { strictEmail } from '../../../shared/email.ts';
import { methodScope, modeOf } from '../../platform/auth.ts';
import { defaultBodyLimit } from '../../platform/body-limit.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { registerEventRoutes } from '../events/routes.ts';
import { bindPassConnection } from './connection-bind.ts';
import { diffVersions, getPassDetail, getVersionDetail } from './detail.ts';
import {
  actorFor,
  authOf,
  passScopeOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from './http.ts';
import { requireTenantPassRead, tenantPassForRead, tenantPassForWrite } from './pass-access.ts';
import { rotateLink } from './pass-service-delivery.ts';
import { requestRefresh } from './pass-service-refresh.ts';
import { registerRemoveRoutes } from './remove-routes.ts';
import { registerActionRoutes } from './routes-actions.ts';
import { registerAssetRoutes } from './routes-assets.ts';
import { registerBulkRoutes } from './routes-bulk.ts';
import { registerCheckInRoutes } from './routes-check-in.ts';
import { registerMemberPhotoRoutes } from './routes-member-photo.ts';
import { registerWriteRoutes } from './routes-write.ts';
import { deletePass, listPassSummaries, unvoidPass, voidPass } from './service.ts';

export const passesRoutes = createRouter({ bodyLimit: false });
/** Image overrides have their own cap (routes-assets.ts). */
passesRoutes.use('*', defaultBodyLimit(/\/(?:assets\/[^/]+|member-photo)$/));
guard(
  passesRoutes,
  requireTenantSessionOrApiKey(methodScope({ read: 'passes:read', write: 'passes:write' })),
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
    const ctx = svc(c);
    const auth = authOf(c);
    // A key bound to an org lists that org by default. A global key must say so: `orgId=null` is explicit.
    const orgId =
      q.orgId !== undefined
        ? q.orgId
        : auth.kind === 'api_key' && auth.orgId !== null
          ? auth.orgId
          : undefined;
    if (orgId === undefined)
      throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
    if (orgId === null) {
      if (auth.kind !== 'api_key' || auth.orgId !== null)
        throw new ForbiddenError(
          'A global API key is required for platform-wide pass lists.',
          'ORG_FORBIDDEN',
        );
    } else {
      await requireTenantPassRead(ctx, auth, orgId);
    }
    const holderEmail = q.holderEmail ? strictEmail(q.holderEmail) : undefined;
    if (q.holderEmail && !holderEmail) return c.json({ items: [], nextCursor: null });
    return c.json(
      await listPassSummaries(ctx, {
        orgId,
        mode: modeOf(auth),
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
    const ctx = svc(c);
    const id = c.req.valid('param').id;
    const auth = authOf(c);
    const { scope, pass } = await tenantPassForRead(ctx, auth, id, passScopeOf(c));
    const authority = await tenantAuthorityOf(ctx, auth, pass.orgId, 'passes:read');
    const detail = await getPassDetail(ctx, id, scope, authority);
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
    const ctx = svc(c);
    const id = c.req.valid('param').id;
    const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
    const detail = await bindPassConnection(
      ctx,
      actorFor(c),
      id,
      c.req.valid('json'),
      scope,
      authority,
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
    const ctx = svc(c);
    const id = c.req.valid('param').id;
    const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
    await deletePass(ctx, actorFor(c), id, scope, authority);
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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return c.json(await action(ctx, actorFor(c), id, scope, authority));
    },
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
    const ctx = svc(c);
    const id = c.req.valid('param').id;
    const { pass, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
    const { requestedAt } = await requestRefresh(
      ctx,
      id,
      actorFor(c),
      {
        orgId: pass.orgId,
        identityId: pass.identityId,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        releaseId: pass.releaseId,
        mode: pass.mode,
        version: pass.version,
        linkGeneration: pass.linkGeneration,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        status: pass.status,
        connectionId: pass.connectionId,
        externalRef: pass.externalRef,
      },
      authority,
    );
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
  async (c) => {
    const ctx = svc(c);
    const id = c.req.valid('param').id;
    const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
    return c.json(await rotateLink(ctx, actorFor(c), id, scope, authority));
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
    const ctx = svc(c);
    const auth = authOf(c);
    const { scope, pass } = await tenantPassForRead(ctx, auth, p.id, passScopeOf(c));
    const authority = await tenantAuthorityOf(ctx, auth, pass.orgId, 'passes:read');
    return c.json(await getVersionDetail(ctx, p.id, p.version, scope, authority));
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
    const ctx = svc(c);
    const id = c.req.valid('param').id;
    const auth = authOf(c);
    const { scope, pass } = await tenantPassForRead(ctx, auth, id, passScopeOf(c));
    const authority = await tenantAuthorityOf(ctx, auth, pass.orgId, 'passes:read');
    return c.json(await diffVersions(ctx, id, q.from, q.to, scope, authority));
  },
);

registerWriteRoutes(passesRoutes);
registerActionRoutes(passesRoutes);
registerAssetRoutes(passesRoutes);
registerMemberPhotoRoutes(passesRoutes);
registerCheckInRoutes(passesRoutes);
registerBulkRoutes(passesRoutes);
registerEventRoutes(passesRoutes);
registerRemoveRoutes(passesRoutes);

import { z } from 'zod';
import {
  BindPassConnectionSchema,
  CreatePassSchema,
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
  UpdatePassSchema,
} from '../../../shared/contracts/index.ts';
import { strictEmail } from '../../../shared/email.ts';
import { methodScope, modeOf, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { defaultBodyLimit } from '../../platform/body-limit.ts';
import { BadRequestError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { registerEventRoutes } from '../events/routes.ts';
import { bindPassConnection } from './connection-bind.ts';
import { createPassIdempotent } from './create.ts';
import { diffVersions, getPassDetail, getVersionDetail } from './detail.ts';
import { actorFor, assertOrg, type C, orgScopeOf, svc } from './http.ts';
import { registerAssetRoutes } from './routes-assets.ts';
import { registerBulkRoutes } from './routes-bulk.ts';
import {
  deletePass,
  listPassSummaries,
  requestRefresh,
  requirePass,
  resendEmail,
  rotateLink,
  unvoidPass,
  updatePass,
  voidPass,
} from './service.ts';

export const passesRoutes = createRouter({ bodyLimit: false });
/** Image overrides have their own cap (routes-assets.ts). */
passesRoutes.use('*', defaultBodyLimit(/\/assets\/[^/]+$/));
guard(
  passesRoutes,
  requireApiKeyOrAdmin(methodScope({ read: 'passes:read', write: 'passes:write' })),
);

function ifMatch(c: C): number | undefined {
  const raw = c.req.header('if-match');
  if (raw === undefined) return undefined;
  const match = /^(?:W\/)?"?(\d{1,12})"?$/.exec(raw.trim());
  if (!match?.[1])
    throw new BadRequestError('If-Match must be the pass version.', 'IF_MATCH_INVALID');
  return Number(match[1]);
}

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
    method: 'post',
    path: '/',
    summary: 'Create a pass (Idempotency-Key supported)',
    body: CreatePassSchema,
    status: 201,
    response: PassDetailSchema,
  },
  async (c) => {
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    const key = c.req.header('idempotency-key')?.trim();
    if (key !== undefined && (key.length < 1 || key.length > 200))
      throw new BadRequestError(
        'Idempotency-Key must be 1 to 200 characters.',
        'IDEMPOTENCY_KEY_INVALID',
      );
    const detail = await createPassIdempotent(
      svc(c),
      {
        orgId: body.orgId,
        templateId: body.templateId,
        ...(body.templateVersion ? { templateVersion: body.templateVersion } : {}),
        ...(body.identityId ? { identityId: body.identityId } : {}),
        input: body.input,
        holderEmail: body.holderEmail ?? null,
        externalId: body.externalId ?? null,
        ...(body.serial ? { serial: body.serial } : {}),
        connectionId: body.connectionId ?? null,
        externalRef: body.externalRef ?? null,
        sendEmail: body.sendEmail ?? false,
        source: 'manual',
        mode: modeOf(c.var.auth),
        actor: actorFor(c),
      },
      key,
    );
    return c.json(detail, 201);
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
    const detail = await getPassDetail(svc(c), c.req.valid('param').id, orgScopeOf(c));
    return c.json(detail, 200, { etag: `"${detail.version}"` });
  },
);

register(
  passesRoutes,
  'passes',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update a pass (If-Match: version)',
    params: IdParamSchema,
    body: UpdatePassSchema,
    response: PassDetailSchema,
  },
  async (c) => {
    const patch = c.req.valid('json');
    const expected = ifMatch(c);
    const detail = await updatePass(svc(c), actorFor(c), c.req.valid('param').id, patch, {
      scope: orgScopeOf(c),
      ...(expected !== undefined ? { ifMatch: expected } : {}),
    });
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
      orgScopeOf(c),
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
    await deletePass(svc(c), actorFor(c), c.req.valid('param').id, orgScopeOf(c));
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
    async (c) => c.json(await action(svc(c), actorFor(c), c.req.valid('param').id, orgScopeOf(c))),
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
    await requirePass(svc(c), id, orgScopeOf(c));
    const { requestedAt } = await requestRefresh(svc(c), id, actorFor(c));
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
    c.json(await rotateLink(svc(c), actorFor(c), c.req.valid('param').id, orgScopeOf(c))),
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
      orgScopeOf(c),
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
    return c.json(await getVersionDetail(svc(c), p.id, p.version, orgScopeOf(c)));
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
    return c.json(await diffVersions(svc(c), c.req.valid('param').id, q.from, q.to, orgScopeOf(c)));
  },
);

registerAssetRoutes(passesRoutes);
registerBulkRoutes(passesRoutes);
registerEventRoutes(passesRoutes);

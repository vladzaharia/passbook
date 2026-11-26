import { z } from 'zod';
import { CursorQuerySchema, IdSchema } from '../../../shared/contracts/common.ts';
import {
  TagListQuerySchema,
  TagListSchema,
  TagSchema,
  UpdateTagSchema,
} from '../../../shared/contracts/nfc-tags.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, orgIdOf } from '../passes/http.ts';
import { bindingTarget, passFacts } from './repo-tag-bindings.ts';
import { listTags, passTagViews, tagView } from './repo-tags.ts';
import {
  actingIn,
  actingKeyOrSession,
  CONSOLE,
  keyReachesPass,
  limitedKeyRefusal,
  orgNotFound,
  passNotFound,
  tagNotFound,
  tagOrg,
} from './route-access.ts';
import { registerEnrollmentRoutes } from './routes-enrollments.ts';
import { registerKeysetRoutes } from './routes-keysets.ts';
import { registerTagMoreRoutes } from './routes-more.ts';
import { registerTagTypeRoutes } from './routes-types.ts';
import {
  reportTagLost,
  restoreTag,
  retireTag,
  tagAuthorityOf,
  tagWriterOf,
  unbindTag,
  updateTag,
} from './tags-admin.ts';
import { listSparesFor } from './tags-spare.ts';

/**
 * Tags bound to passes and people: /api/v1/nfc. Console sessions only (`CONSOLE`), except the keyset routes (an
 * `nfc:keys` key) and the tag routes that take `nfc:read` or `nfc:write`, which say so in their own `auth`.
 */
export const nfcRoutes = createRouter();
nfcRoutes.use('*', limitBody(8 * 1024));

const TAG = 'nfc-tags';
const IdParam = z.object({ id: IdSchema });
const PassParam = z.object({ passId: IdSchema });
const BindingParam = z.object({ bindingId: IdSchema });

register(
  nfcRoutes,
  TAG,
  {
    method: 'get',
    path: '/passes/{passId}/tags',
    summary: 'Tags that open a pass',
    auth: { scope: 'nfc:read', capability: 'passes:read', templateScoped: true },
    params: PassParam,
    query: CursorQuerySchema,
    response: TagListSchema,
  },
  async (c) => {
    const pass = await passFacts(serviceContext(c).env.DB, c.req.valid('param').passId);
    if (!pass) throw passNotFound();
    const { ctx, authority, limited } = await actingKeyOrSession(
      c,
      pass.orgId,
      'passes:read',
      passNotFound,
    );
    if (pass.mode !== authority.mode || pass.deletedAt !== null) throw passNotFound();
    if (!(await keyReachesPass(c, authority, pass.id))) throw passNotFound();
    return c.json({ items: await passTagViews(ctx.env.DB, pass, limited), nextCursor: null });
  },
);

register(
  nfcRoutes,
  TAG,
  {
    method: 'delete',
    path: '/bindings/{bindingId}',
    summary: 'Remove a tag from its pass or person',
    auth: { scope: 'nfc:write', capability: 'passes:operate', templateScoped: true },
    params: BindingParam,
    response: TagSchema,
  },
  async (c) => {
    const binding = await bindingTarget(serviceContext(c).env.DB, c.req.valid('param').bindingId);
    if (!binding) throw tagNotFound();
    const { ctx, authority, limited } = await actingKeyOrSession(
      c,
      binding.orgId,
      'passes:operate',
      tagNotFound,
    );
    if (limited && binding.scope !== 'pass') throw limitedKeyRefusal();
    if (!(await keyReachesPass(c, authority, binding.passId))) throw tagNotFound();
    return c.json(await unbindTag(ctx, tagWriterOf(authority), binding.id));
  },
);

register(
  nfcRoutes,
  TAG,
  {
    method: 'get',
    path: '/tags',
    summary: 'List tags',
    // A limited key lists spares only: a bound tag names its pass.
    auth: { scope: 'nfc:read', capability: 'passes:read', templateScoped: true },
    query: TagListQuerySchema,
    response: TagListSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    const orgId = orgIdOf(authOf(c), q.orgId);
    const { ctx, authority, limited } = await actingKeyOrSession(
      c,
      orgId,
      'passes:read',
      orgNotFound,
    );
    if (limited && q.status !== 'spare') throw limitedKeyRefusal();
    // Spares fitted to a pass tell what its policy takes: only a pass inside the limit.
    if (limited && q.passId && !(await keyReachesPass(c, authority, q.passId)))
      throw passNotFound();
    const filter = {
      orgId,
      mode: authority.mode,
      status: q.status,
      q: q.q,
      cursor: q.cursor,
      limit: q.limit ?? 50,
    };
    return c.json(
      q.passId && q.status === 'spare'
        ? await listSparesFor(ctx, filter, q.passId, q.binding ?? 'pass')
        : await listTags(ctx.env.DB, filter),
    );
  },
);

register(
  nfcRoutes,
  TAG,
  {
    method: 'get',
    path: '/tags/{id}',
    summary: 'Get a tag',
    auth: { scope: 'nfc:read', capability: 'passes:read' },
    params: IdParam,
    response: TagSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const { ctx, authority } = await actingKeyOrSession(
      c,
      await tagOrg(c, id),
      'passes:read',
      tagNotFound,
    );
    const tag = await tagView(ctx.env.DB, authority.orgId, authority.mode, id);
    if (!tag) throw tagNotFound();
    return c.json(tag);
  },
);

register(
  nfcRoutes,
  TAG,
  {
    method: 'patch',
    path: '/tags/{id}',
    summary: 'Rename a tag',
    auth: CONSOLE,
    params: IdParam,
    body: UpdateTagSchema,
    response: TagSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const { ctx, authority } = await actingIn(
      c,
      await tagOrg(c, id),
      'passes:operate',
      tagNotFound,
    );
    return c.json(await updateTag(ctx, tagAuthorityOf(authority), id, c.req.valid('json')));
  },
);

register(
  nfcRoutes,
  TAG,
  {
    method: 'post',
    path: '/tags/{id}/retire',
    summary: 'Retire a tag',
    auth: CONSOLE,
    params: IdParam,
    response: TagSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const { ctx, authority } = await actingIn(
      c,
      await tagOrg(c, id),
      'passes:operate',
      tagNotFound,
    );
    return c.json(await retireTag(ctx, tagAuthorityOf(authority), id));
  },
);

for (const [action, summary, act] of [
  ['restore', 'Restore a retired or lost tag', restoreTag],
  ['lost', 'Report a tag lost', reportTagLost],
] as const)
  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: `/tags/{id}/${action}` as const,
      summary,
      auth: { scope: 'nfc:write', capability: 'passes:operate' },
      params: IdParam,
      response: TagSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const { ctx, authority } = await actingKeyOrSession(
        c,
        await tagOrg(c, id),
        'passes:operate',
        tagNotFound,
      );
      return c.json(await act(ctx, tagWriterOf(authority), id));
    },
  );

registerEnrollmentRoutes(nfcRoutes);
registerTagMoreRoutes(nfcRoutes);
registerTagTypeRoutes(nfcRoutes);
registerKeysetRoutes(nfcRoutes);

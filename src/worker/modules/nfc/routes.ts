import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import {
  TagListQuerySchema,
  TagListSchema,
  TagSchema,
  UpdateTagSchema,
} from '../../../shared/contracts/nfc-tags.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import {
  bindingTarget,
  listTags,
  passFacts,
  passTagViews,
  tagTarget,
  tagView,
} from './repo-tags.ts';
import {
  reportTagLost,
  restoreTag,
  retireTag,
  tagAuthorityOf,
  unbindTag,
  updateTag,
} from './tags-admin.ts';

/** Tags bound to passes and people: /api/v1/nfc. Console sessions only; API keys have no tag routes. */
export const nfcRoutes = createRouter();
guard(nfcRoutes, requireTenantSession);
nfcRoutes.use('*', limitBody(8 * 1024));

const TAG = 'nfc-tags';
const IdParam = z.object({ id: IdSchema });
const PassParam = z.object({ passId: IdSchema });
const BindingParam = z.object({ bindingId: IdSchema });
const ListQuery = TagListQuerySchema.extend({ orgId: IdSchema });

const tagNotFound = () => new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');
const passNotFound = () => new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
const orgNotFound = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');

/** A tenant session with this capability in the org; an org the user is not in is a 404. */
async function actingIn(
  c: C,
  orgId: string,
  capability: 'passes:read' | 'passes:operate',
  notFound: () => Error,
) {
  const ctx = serviceContext(c);
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (!(await getOrgAccess(ctx, auth.userId, orgId))) throw notFound();
  return { ctx, authority: await tenantAuthorityOf(ctx, auth, orgId, capability) };
}

async function tagOrg(c: C, id: string): Promise<string> {
  const tag = await tagTarget(serviceContext(c).env.DB, id);
  if (!tag) throw tagNotFound();
  return tag.orgId;
}

register(
  nfcRoutes,
  TAG,
  {
    method: 'get',
    path: '/passes/{passId}/tags',
    summary: 'Tags that open a pass',
    params: PassParam,
    response: TagListSchema,
  },
  async (c) => {
    const pass = await passFacts(serviceContext(c).env.DB, c.req.valid('param').passId);
    if (!pass) throw passNotFound();
    const { ctx, authority } = await actingIn(c, pass.orgId, 'passes:read', passNotFound);
    if (pass.mode !== authority.mode || pass.deletedAt !== null) throw passNotFound();
    return c.json({ items: await passTagViews(ctx.env.DB, pass), nextCursor: null });
  },
);

register(
  nfcRoutes,
  TAG,
  {
    method: 'delete',
    path: '/bindings/{bindingId}',
    summary: 'Remove a tag from its pass or person',
    params: BindingParam,
    response: TagSchema,
  },
  async (c) => {
    const binding = await bindingTarget(serviceContext(c).env.DB, c.req.valid('param').bindingId);
    if (!binding) throw tagNotFound();
    const { ctx, authority } = await actingIn(c, binding.orgId, 'passes:operate', tagNotFound);
    return c.json(await unbindTag(ctx, tagAuthorityOf(authority), binding.id));
  },
);

register(
  nfcRoutes,
  TAG,
  { method: 'get', path: '/tags', summary: 'List tags', query: ListQuery, response: TagListSchema },
  async (c) => {
    const q = c.req.valid('query');
    const { ctx, authority } = await actingIn(c, q.orgId, 'passes:read', orgNotFound);
    return c.json(
      await listTags(ctx.env.DB, {
        orgId: q.orgId,
        mode: authority.mode,
        status: q.status,
        q: q.q,
        cursor: q.cursor,
        limit: q.limit ?? 50,
      }),
    );
  },
);

register(
  nfcRoutes,
  TAG,
  { method: 'get', path: '/tags/{id}', summary: 'Get a tag', params: IdParam, response: TagSchema },
  async (c) => {
    const id = c.req.valid('param').id;
    const { ctx, authority } = await actingIn(c, await tagOrg(c, id), 'passes:read', tagNotFound);
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

for (const [action, summary, act] of [
  ['retire', 'Retire a tag', retireTag],
  ['restore', 'Restore a retired or lost tag', restoreTag],
  ['lost', 'Report a tag lost', reportTagLost],
] as const)
  register(
    nfcRoutes,
    TAG,
    { method: 'post', path: `/tags/{id}/${action}`, summary, params: IdParam, response: TagSchema },
    async (c) => {
      const id = c.req.valid('param').id;
      const { ctx, authority } = await actingIn(
        c,
        await tagOrg(c, id),
        'passes:operate',
        tagNotFound,
      );
      return c.json(await act(ctx, tagAuthorityOf(authority), id));
    },
  );

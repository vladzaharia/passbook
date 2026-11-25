import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { CursorQuerySchema, IdSchema } from '../../../shared/contracts/common.ts';
import {
  AssignTagSchema,
  ChangeTagBindingSchema,
  RebindTagSchema,
  TagHistorySchema,
  UserTagListQuerySchema,
  UserTagListSchema,
} from '../../../shared/contracts/nfc-tag-admin.ts';
import { TagSchema } from '../../../shared/contracts/nfc-tags.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { bindingTarget, passFacts } from './repo-tag-bindings.ts';
import {
  orgNameOf,
  tagBindingHistory,
  tagEvents,
  userPassOrgs,
  userTagIds,
} from './repo-tag-history.ts';
import { tagView, tagViewsByIds } from './repo-tags.ts';
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
import { tagAuthorityOf, tagWriterOf } from './tags-admin.ts';
import { assignTag } from './tags-assign.ts';
import { changeBinding, rebindRemoved } from './tags-rebind.ts';

const TAG = 'nfc-tags';
const HISTORY_PAGE = 50;

/** What an admin changes on a tag that is already bound: works with, Undo on remove, history, one user's tags. */
export function registerTagMoreRoutes(nfcRoutes: OpenAPIHono<AppBindings>): void {
  register(
    nfcRoutes,
    TAG,
    {
      method: 'patch',
      path: '/bindings/{bindingId}',
      summary: 'Change what a tag works with',
      auth: { ...CONSOLE, feature: { key: 'nfc', atLeast: 'basic' } },
      params: z.object({ bindingId: IdSchema }),
      body: ChangeTagBindingSchema,
      response: TagSchema,
    },
    async (c) => {
      const binding = await bindingTarget(serviceContext(c).env.DB, c.req.valid('param').bindingId);
      if (!binding) throw tagNotFound();
      const { ctx, authority } = await actingIn(c, binding.orgId, 'passes:operate', tagNotFound);
      return c.json(
        await changeBinding(ctx, tagAuthorityOf(authority), binding.id, c.req.valid('json')),
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/passes/{passId}/tags',
      summary: 'Put a removed tag back on a pass',
      auth: { ...CONSOLE, feature: { key: 'nfc', atLeast: 'basic' } },
      params: z.object({ passId: IdSchema }),
      body: RebindTagSchema,
      response: TagSchema,
    },
    async (c) => {
      const { passId } = c.req.valid('param');
      const pass = await passFacts(serviceContext(c).env.DB, passId);
      if (!pass) throw passNotFound();
      const { ctx, authority } = await actingIn(c, pass.orgId, 'passes:operate', passNotFound);
      return c.json(
        await rebindRemoved(ctx, tagAuthorityOf(authority), passId, c.req.valid('json')),
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/passes/{passId}/tags/assign',
      summary: 'Assign a typed tag ID or a spare tag to a pass',
      auth: {
        scope: 'nfc:write',
        capability: 'passes:operate',
        feature: { key: 'nfc', atLeast: 'basic' },
        templateScoped: true,
      },
      params: z.object({ passId: IdSchema }),
      body: AssignTagSchema,
      response: TagSchema,
    },
    async (c) => {
      const { passId } = c.req.valid('param');
      const pass = await passFacts(serviceContext(c).env.DB, passId);
      if (!pass) throw passNotFound();
      const { ctx, authority, limited } = await actingKeyOrSession(
        c,
        pass.orgId,
        'passes:operate',
        passNotFound,
      );
      if (!(await keyReachesPass(c, authority, pass.id))) throw passNotFound();
      const input = c.req.valid('json');
      // A limited key writes no tag row (a new tag has no template): spares, on the pass, only.
      if (limited && ('id' in input || input.binding === 'user')) throw limitedKeyRefusal();
      return c.json(await assignTag(ctx, tagWriterOf(authority), passId, input));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'get',
      path: '/tags/{id}/history',
      summary: 'Every binding a tag has had',
      auth: { scope: 'nfc:read', capability: 'passes:read' },
      params: z.object({ id: IdSchema }),
      query: z.object({ cursor: z.coerce.number().int().min(1).optional() }),
      response: TagHistorySchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { cursor } = c.req.valid('query');
      const { ctx, authority } = await actingKeyOrSession(
        c,
        await tagOrg(c, id),
        'passes:read',
        tagNotFound,
      );
      if (!(await tagView(ctx.env.DB, authority.orgId, authority.mode, id))) throw tagNotFound();
      const page = await tagBindingHistory(ctx.env.DB, id, HISTORY_PAGE, cursor);
      return c.json({
        ...page,
        events: cursor === undefined ? await tagEvents(ctx.env.DB, authority.orgId, id) : [],
      });
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'get',
      path: '/users/{userId}/tags',
      summary: "Tags that open a user's passes",
      auth: CONSOLE,
      params: z.object({ userId: IdSchema }),
      query: UserTagListQuerySchema.extend(CursorQuerySchema.shape),
      response: UserTagListSchema,
    },
    async (c) => {
      const { userId } = c.req.valid('param');
      const { orgId } = c.req.valid('query');
      const ctx = serviceContext(c);
      const auth = c.var.auth;
      const mode = auth?.kind === 'session' ? auth.mode : 'live';
      const orgs = orgId
        ? [{ orgId, orgName: await orgNameOf(ctx.env.DB, orgId) }]
        : await userPassOrgs(ctx.env.DB, userId, mode);
      const items = [];
      for (const org of orgs) {
        // An org the caller cannot read passes in is not listed, and a named one is a 404.
        if (!orgId) {
          const access =
            auth?.kind === 'session' ? await getOrgAccess(ctx, auth.userId, org.orgId) : null;
          if (!access?.capabilities.includes('passes:read')) continue;
        }
        const acting = await actingIn(c, org.orgId, 'passes:read', orgNotFound);
        const ids = await userTagIds(ctx.env.DB, org.orgId, acting.authority.mode, userId);
        for (const tag of await tagViewsByIds(ctx.env.DB, org.orgId, acting.authority.mode, ids))
          items.push({ ...tag, orgId: org.orgId, orgName: org.orgName });
      }
      return c.json({ items, nextCursor: null });
    },
  );
}

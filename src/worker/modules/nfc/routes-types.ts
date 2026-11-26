import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { IdParamSchema, IdSchema } from '../../../shared/contracts/common.ts';
import {
  CreateTagTypeSchema,
  TagTypeListQuerySchema,
  TagTypeListSchema,
  TagTypeSchema,
  UpdateTagTypeSchema,
} from '../../../shared/contracts/nfc-tag-admin.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { assertSharedWrite } from '../orgs/shared-write.ts';
import { webhookOrg } from '../webhooks/access.ts';
import { listTagTypes, tagTypeOrg } from './repo-tag-types.ts';
import {
  archiveTagType,
  createTagType,
  tagTypeAccess,
  tagTypeNotFound,
  updateType,
} from './tag-types.ts';

const TAG = 'nfc-tags';
const OrgQuerySchema = z.object({ orgId: IdSchema.optional() });
const ArchiveSchema = z.strictObject({ version: z.number().int().min(1) });

/**
 * /api/v1/nfc/tag-types. A session needs `scanning:read` to view and `scanning:manage` to change, through
 * its membership. A key needs `scans:read` to view and `scanning:write` to change; org-bound keys may omit `orgId`.
 */
export function registerTagTypeRoutes(nfcRoutes: OpenAPIHono<AppBindings>): void {
  register(
    nfcRoutes,
    TAG,
    {
      method: 'get',
      auth: { scope: 'scans:read', capability: 'scanning:read' },
      path: '/tag-types',
      summary: 'Tag types of an organization',
      query: TagTypeListQuerySchema,
      response: TagTypeListSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { orgId: asked, ...page } = c.req.valid('query');
      const orgId = webhookOrg(c.var.auth, asked);
      await tagTypeAccess(ctx, c.var.auth, orgId, 'scanning:read');
      return c.json(await listTagTypes(ctx.env.DB, orgId, page));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      auth: { scope: 'scanning:write', capability: 'scanning:manage' },
      path: '/tag-types',
      summary: 'Create a tag type',
      query: OrgQuerySchema,
      body: CreateTagTypeSchema,
      response: TagTypeSchema,
      status: 201,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const orgId = webhookOrg(c.var.auth, c.req.valid('query').orgId);
      const authority = await tagTypeAccess(ctx, c.var.auth, orgId, 'scanning:manage');
      await assertSharedWrite(ctx, authority, orgId, 'tag types');
      return c.json(
        await createTagType(ctx, actorOf(c.var.auth), authority, c.req.valid('json')),
        201,
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'patch',
      auth: { scope: 'scanning:write', capability: 'scanning:manage' },
      path: '/tag-types/{id}',
      summary: 'Change a tag type (send the version you read)',
      params: IdParamSchema,
      body: UpdateTagTypeSchema,
      response: TagTypeSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const authority = await typeAuthority(c, id, 'scanning:manage');
      return c.json(await updateType(ctx, actorOf(c.var.auth), authority, id, c.req.valid('json')));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      auth: { scope: 'scanning:write', capability: 'scanning:manage' },
      path: '/tag-types/{id}/archive',
      summary: 'Archive a tag type; its tags keep working',
      params: IdParamSchema,
      body: ArchiveSchema,
      response: TagTypeSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const authority = await typeAuthority(c, id, 'scanning:manage');
      return c.json(
        await archiveTagType(ctx, actorOf(c.var.auth), authority, id, c.req.valid('json').version),
      );
    },
  );
}

/** By-id routes: the type's own org decides; a caller outside it learns nothing (404). */
async function typeAuthority(
  c: Parameters<typeof serviceContext>[0],
  id: string,
  capability: 'scanning:read' | 'scanning:manage',
) {
  const ctx = serviceContext(c);
  const orgId = await tagTypeOrg(ctx.env.DB, id);
  if (!orgId) throw tagTypeNotFound();
  const authority = await tagTypeAccess(ctx, c.var.auth, orgId, capability, tagTypeNotFound);
  if (capability === 'scanning:manage') await assertSharedWrite(ctx, authority, orgId, 'tag types');
  return authority;
}

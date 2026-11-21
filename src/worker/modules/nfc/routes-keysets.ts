import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { CursorQuerySchema, IdSchema } from '../../../shared/contracts/common.ts';
import {
  ImportTagsSchema,
  MadeTagKeysetSchema,
  ReenrolledTagKeysetSchema,
  ReenrolTagKeysetSchema,
  RotateTagKeysetSchema,
  TagImportResultSchema,
  TagKeysetListQuerySchema,
  TagKeysetListSchema,
  TagKeysetViewSchema,
  TagKeyVersionParamSchema,
} from '../../../shared/contracts/nfc-tag-keysets.ts';
import { CreateTagKeysetSchema } from '../../../shared/contracts/nfc-tags.ts';
import type { AppBindings } from '../../platform/context.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireStepUp, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, tenantAuthorityOf } from '../passes/http.ts';
import { importTags } from './import.ts';
import {
  createKeyset,
  disableKeyset,
  keysetAuthorityOf,
  listKeysets,
  retireKeyVersion,
  rotateKeyset,
} from './keysets.ts';
import { reenrolTags, revokeKeyVersion } from './keysets-recover.ts';
import { keysetById } from './repo-keysets.ts';

const TAG = 'nfc-keysets';
const IdParam = z.object({ id: IdSchema });
const notFound = () => new NotFoundError('Keyset not found.', 'KEYSET_NOT_FOUND');

/** Console session with this capability in the org; an org the user is not in is a 404. */
async function acting(
  c: C,
  orgId: string,
  capability: 'scanning:read' | 'scanning:manage',
  missing: () => Error,
) {
  const ctx = serviceContext(c);
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (!(await getOrgAccess(ctx, auth.userId, orgId))) throw missing();
  return { ctx, authority: await tenantAuthorityOf(ctx, auth, orgId, capability) };
}

/** The org of the keyset in the path, before any authority exists for it. */
async function managing(c: C, id: string) {
  const row = await keysetById(serviceContext(c).env.DB, id);
  if (!row) throw notFound();
  const { ctx, authority } = await acting(c, row.orgId, 'scanning:manage', notFound);
  return { ctx, authority: keysetAuthorityOf(authority) };
}

/**
 * Secure tag keysets under /api/v1/nfc/keysets. Console sessions with scanning:read (list) or scanning:manage.
 * Keys are write-only: only the response that generates them carries them.
 */
export function registerKeysetRoutes(nfcRoutes: OpenAPIHono<AppBindings>): void {
  // A new key version replaces what authenticates every tag of the keyset: a recent sign-in.
  nfcRoutes.post('/keysets/:id/rotate', requireStepUp(STEP_UP_SECONDS));
  register(
    nfcRoutes,
    TAG,
    {
      method: 'get',
      path: '/keysets',
      summary: 'List tag keysets',
      query: TagKeysetListQuerySchema.extend(CursorQuerySchema.shape),
      response: TagKeysetListSchema,
    },
    async (c) => {
      const { orgId } = c.req.valid('query');
      const { ctx, authority } = await acting(
        c,
        orgId,
        'scanning:read',
        () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND'),
      );
      return c.json({ items: await listKeysets(ctx, orgId, authority.mode), nextCursor: null });
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets',
      summary: 'Create a tag keyset',
      xFeature: { key: 'nfc', atLeast: 'secure' },
      query: TagKeysetListQuerySchema,
      body: CreateTagKeysetSchema,
      status: 201,
      response: MadeTagKeysetSchema,
    },
    async (c) => {
      const { orgId } = c.req.valid('query');
      const { ctx, authority } = await acting(
        c,
        orgId,
        'scanning:manage',
        () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND'),
      );
      return c.json(
        await createKeyset(ctx, keysetAuthorityOf(authority), c.req.valid('json')),
        201,
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/rotate',
      summary: 'Rotate a keyset to a new key version',
      params: IdParam,
      body: RotateTagKeysetSchema,
      response: MadeTagKeysetSchema,
    },
    async (c) => {
      const { ctx, authority } = await managing(c, c.req.valid('param').id);
      return c.json(
        await rotateKeyset(ctx, authority, c.req.valid('param').id, c.req.valid('json')),
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/keys/{version}/retire',
      summary: 'Retire an old key version',
      params: TagKeyVersionParamSchema,
      response: TagKeysetViewSchema,
    },
    async (c) => {
      const { id, version } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(await retireKeyVersion(ctx, authority, id, version));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/keys/{version}/revoke',
      summary: 'Revoke a key version: tags on it must be written again',
      params: TagKeyVersionParamSchema,
      response: TagKeysetViewSchema,
    },
    async (c) => {
      const { id, version } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(await revokeKeyVersion(ctx, authority, id, version));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/reenrol',
      summary: 'Move the tags of a keyset to another keyset',
      params: IdParam,
      body: ReenrolTagKeysetSchema,
      response: ReenrolledTagKeysetSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(await reenrolTags(ctx, authority, id, c.req.valid('json').toKeysetId));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/import',
      summary: 'Import supplier-personalised tags (dry run or add)',
      params: IdParam,
      body: ImportTagsSchema,
      response: TagImportResultSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(await importTags(ctx, authority, id, c.req.valid('json')));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/disable',
      summary: 'Disable a keyset',
      params: IdParam,
      response: TagKeysetViewSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(await disableKeyset(ctx, authority, id));
    },
  );
}

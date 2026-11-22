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
import { ipPrefix } from '../../platform/ip.ts';
import { register } from '../../platform/openapi.ts';
import { clientIp } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, tenantAuthorityOf } from '../passes/http.ts';
import { credentialOnce, withoutSecrets } from '../scan/credential-once.ts';
import { chargedKeysetWrite, orgOf } from '../scan/key-credentials.ts';
import { importTags } from './import.ts';
import { keysetRequestBody } from './keyset-idem.ts';
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

/**
 * The caller in an org: a console session with this capability (an org the user is not in is a 404), or a
 * key bound to the org (another org, and a platform key with no org, get the same 404). A key proves
 * `scanning:manage`, which `nfc:keys` stands for.
 */
async function acting(
  c: C,
  orgId: string,
  capability: 'scanning:read' | 'scanning:manage',
  missing: () => Error,
) {
  const ctx = serviceContext(c);
  const auth = c.var.auth;
  if (auth?.kind === 'api_key') {
    // Keyset keys are live only: a test-mode key (forced past the mint rule) finds nothing.
    if (auth.orgId !== orgId || auth.mode !== 'live') throw missing();
    return { ctx, authority: await tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage') };
  }
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (!(await getOrgAccess(ctx, auth.userId, orgId))) throw missing();
  return { ctx, authority: await tenantAuthorityOf(ctx, auth, orgId, capability) };
}

const ipOf = (c: C) => ipPrefix(clientIp(c));

/** The org of the keyset in the path, before any authority exists for it. */
async function managing(c: C, id: string) {
  const row = await keysetById(serviceContext(c).env.DB, id);
  if (!row) throw notFound();
  const { ctx, authority } = await acting(c, row.orgId, 'scanning:manage', notFound);
  return { ctx, authority: keysetAuthorityOf(authority, ipOf(c)) };
}

const LIST = { scope: 'nfc:keys' } as const;
const WRITE = { scope: 'nfc:keys', capability: 'scanning:manage' } as const;
const orgMissing = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');

/**
 * Secure tag keysets under /api/v1/nfc/keysets. Console sessions with scanning:read (list) or scanning:manage, or
 * a live `nfc:keys` key of the org. Keys are write-only: only the response that generates them carries them, and
 * an `Idempotency-Key` replay shows `keys: null`. A key's writes share 30 a day.
 */
export function registerKeysetRoutes(nfcRoutes: OpenAPIHono<AppBindings>): void {
  register(
    nfcRoutes,
    TAG,
    {
      method: 'get',
      path: '/keysets',
      summary: 'List tag keysets',
      auth: LIST,
      query: TagKeysetListQuerySchema.extend(CursorQuerySchema.shape),
      response: TagKeysetListSchema,
    },
    async (c) => {
      const orgId = orgOf(c.var.auth, c.req.valid('query').orgId);
      const { ctx, authority } = await acting(c, orgId, 'scanning:read', orgMissing);
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
      auth: { ...WRITE, feature: { key: 'nfc', atLeast: 'secure' } },
      query: TagKeysetListQuerySchema,
      body: CreateTagKeysetSchema,
      status: 201,
      response: MadeTagKeysetSchema,
    },
    async (c) => {
      const orgId = orgOf(c.var.auth, c.req.valid('query').orgId);
      const { ctx, authority } = await acting(c, orgId, 'scanning:manage', orgMissing);
      const a = keysetAuthorityOf(authority, ipOf(c));
      const input = c.req.valid('json');
      return credentialOnce(c, ctx, {
        orgId,
        body: await keysetRequestBody(ctx.env, input),
        status: 201,
        execute: () => chargedKeysetWrite(ctx, a, () => createKeyset(ctx, a, input)),
        redact: (v) => withoutSecrets(MadeTagKeysetSchema, v, ['keys']),
      });
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/rotate',
      summary: 'Rotate a keyset to a new key version',
      // A new key version replaces what authenticates every tag: a session needs a recent sign-in; a key is never asked.
      auth: { ...WRITE, stepUp: { maxAgeSec: STEP_UP_SECONDS } },
      params: IdParam,
      body: RotateTagKeysetSchema,
      response: MadeTagKeysetSchema,
    },
    async (c) => {
      const { ctx, authority } = await managing(c, c.req.valid('param').id);
      const { id } = c.req.valid('param');
      const input = c.req.valid('json');
      return credentialOnce(c, ctx, {
        orgId: authority.orgId,
        body: await keysetRequestBody(ctx.env, input),
        status: 200,
        execute: () =>
          chargedKeysetWrite(ctx, authority, () => rotateKeyset(ctx, authority, id, input)),
        redact: (v) => withoutSecrets(MadeTagKeysetSchema, v, ['keys']),
      });
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/keys/{version}/retire',
      summary: 'Retire an old key version',
      auth: WRITE,
      params: TagKeyVersionParamSchema,
      response: TagKeysetViewSchema,
    },
    async (c) => {
      const { id, version } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(
        await chargedKeysetWrite(ctx, authority, () =>
          retireKeyVersion(ctx, authority, id, version),
        ),
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/keys/{version}/revoke',
      summary: 'Revoke a key version: tags on it must be written again',
      auth: WRITE,
      params: TagKeyVersionParamSchema,
      response: TagKeysetViewSchema,
    },
    async (c) => {
      const { id, version } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(
        await chargedKeysetWrite(ctx, authority, () =>
          revokeKeyVersion(ctx, authority, id, version),
        ),
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/reenrol',
      summary: 'Move the tags of a keyset to another keyset',
      auth: WRITE,
      params: IdParam,
      body: ReenrolTagKeysetSchema,
      response: ReenrolledTagKeysetSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      const { toKeysetId } = c.req.valid('json');
      return c.json(
        await chargedKeysetWrite(ctx, authority, () => reenrolTags(ctx, authority, id, toKeysetId)),
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/import',
      summary: 'Import supplier-personalised tags (dry run or add)',
      auth: WRITE,
      params: IdParam,
      body: ImportTagsSchema,
      response: TagImportResultSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      const input = c.req.valid('json');
      // A dry run writes nothing and costs nothing.
      const run = () => importTags(ctx, authority, id, input);
      return c.json(input.dryRun ? await run() : await chargedKeysetWrite(ctx, authority, run));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/keysets/{id}/disable',
      summary: 'Disable a keyset',
      auth: WRITE,
      params: IdParam,
      response: TagKeysetViewSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { ctx, authority } = await managing(c, id);
      return c.json(
        await chargedKeysetWrite(ctx, authority, () => disableKeyset(ctx, authority, id)),
      );
    },
  );
}

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import { IdParamSchema, IdSchema, OkSchema } from '../../../shared/contracts/common.ts';
import {
  ApplyConnectionFileResponseSchema,
  ConnectionFileRevisionListSchema,
  ConnectionFileRevisionsQuerySchema,
  ConnectionFileSchema,
  ConnectionFileUploadResultSchema,
  UpdateConnectionFileSchema,
  UploadConnectionFileQuerySchema,
  UploadConnectionFileSchema,
  UploadConnectionRevisionQuerySchema,
} from '../../../shared/contracts/connection-files.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf } from '../passes/http.ts';
import { authorizeConnection, authorizeStoredConnection } from './access.ts';
import { FileNotFoundError } from './files-errors.ts';
import * as revisions from './files-revisions.ts';
import * as files from './files-service.ts';
import { connectionListOrg } from './list-routes.ts';
import { fileOrgOf } from './repo-files.ts';
import { requireConnection } from './service-shared.ts';

type C = Context<AppBindings>;
type Router = OpenAPIHono<AppBindings>;
const TAG = 'connections';
const FileParamSchema = z.object({ fileId: IdSchema });
const RevisionParamSchema = z.object({ id: IdSchema, fileId: IdSchema });

/** Stored files have no Test environment. */
function assertLive(c: C): void {
  if (modeOf(c.var.auth) !== 'live') throw new FileNotFoundError();
}

/** A draft by id: a caller with no access to its org learns nothing about it, so it reads as missing. */
async function draftAuthority(
  c: C,
  fileId: string,
  capability: 'integrations:read' | 'integrations:manage',
) {
  const ctx = serviceContext(c);
  const orgId = await fileOrgOf(ctx.env.DB, fileId);
  if (!orgId) throw new FileNotFoundError();
  try {
    return await authorizeStoredConnection(ctx, c.var.auth, orgId, capability);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError)
      throw new FileNotFoundError();
    throw error;
  }
}

async function connectionAuthority(
  c: C,
  id: string,
  capability: 'integrations:read' | 'integrations:manage',
) {
  const ctx = serviceContext(c);
  const conn = await requireConnection(ctx, id);
  return authorizeStoredConnection(ctx, c.var.auth, conn.orgId, capability);
}

/** `/uploads` and `/{id}/files…` of the connections router. The 7 MB body cap is set where the router is made. */
export function registerConnectionFileRoutes(router: Router): void {
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/uploads',
      summary: 'Upload a file as a draft',
      query: UploadConnectionFileQuerySchema,
      body: UploadConnectionFileSchema,
      status: 201,
      response: ConnectionFileSchema,
    },
    async (c) => {
      assertLive(c);
      const ctx = serviceContext(c);
      const body = c.req.valid('json');
      const authority = await authorizeConnection(
        ctx,
        c.var.auth,
        connectionListOrg(c, c.req.valid('query').orgId),
        'integrations:manage',
      );
      return idempotentJson(
        c,
        ctx,
        { orgId: authority.orgId, mode: authority.mode, principal: principalOf(authOf(c)), body },
        201,
        () => files.createDraft(ctx, actorOf(c.var.auth), authority, body),
      );
    },
  );
  register(
    router,
    TAG,
    {
      method: 'get',
      path: '/uploads/{fileId}',
      summary: 'Read a draft upload',
      params: FileParamSchema,
      response: ConnectionFileSchema,
    },
    async (c) => {
      assertLive(c);
      const id = c.req.valid('param').fileId;
      const authority = await draftAuthority(c, id, 'integrations:read');
      return c.json(await files.readDraft(serviceContext(c), authority.orgId, id));
    },
  );
  register(
    router,
    TAG,
    {
      method: 'patch',
      path: '/uploads/{fileId}',
      summary: 'Read a draft again with another sheet or records path',
      params: FileParamSchema,
      body: UpdateConnectionFileSchema,
      response: ConnectionFileSchema,
    },
    async (c) => {
      assertLive(c);
      const id = c.req.valid('param').fileId;
      const authority = await draftAuthority(c, id, 'integrations:manage');
      return c.json(
        await files.reparseDraft(serviceContext(c), authority, id, c.req.valid('json')),
      );
    },
  );
  register(
    router,
    TAG,
    {
      method: 'delete',
      path: '/uploads/{fileId}',
      summary: 'Discard a draft upload',
      params: FileParamSchema,
      response: OkSchema,
    },
    async (c) => {
      assertLive(c);
      const id = c.req.valid('param').fileId;
      const authority = await draftAuthority(c, id, 'integrations:manage');
      await files.discardDraft(serviceContext(c), actorOf(c.var.auth), authority, id);
      return c.json({ ok: true as const });
    },
  );
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/{id}/files',
      summary: 'Upload a new revision of a connection file',
      params: IdParamSchema,
      query: UploadConnectionRevisionQuerySchema,
      body: UploadConnectionFileSchema,
      response: ConnectionFileUploadResultSchema,
    },
    async (c) => {
      assertLive(c);
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const body = c.req.valid('json');
      const apply = c.req.valid('query').apply === 'true';
      const authority = await connectionAuthority(c, id, 'integrations:manage');
      return idempotentJson(
        c,
        ctx,
        {
          orgId: authority.orgId,
          mode: authority.mode,
          principal: principalOf(authOf(c)),
          body: { id, apply, body },
        },
        200,
        () => revisions.uploadRevision(ctx, actorOf(c.var.auth), authority, id, body, apply),
      );
    },
  );
  register(
    router,
    TAG,
    {
      method: 'get',
      path: '/{id}/files',
      summary: 'Revisions of a connection file, newest first',
      params: IdParamSchema,
      query: ConnectionFileRevisionsQuerySchema,
      response: ConnectionFileRevisionListSchema,
    },
    async (c) => {
      assertLive(c);
      const id = c.req.valid('param').id;
      const authority = await connectionAuthority(c, id, 'integrations:read');
      return c.json(
        await revisions.listFiles(serviceContext(c), authority, id, c.req.valid('query')),
      );
    },
  );
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/{id}/files/{fileId}/apply',
      summary: 'Apply a pending revision and sync',
      params: RevisionParamSchema,
      response: ApplyConnectionFileResponseSchema,
    },
    async (c) => {
      assertLive(c);
      const { id, fileId } = c.req.valid('param');
      const authority = await connectionAuthority(c, id, 'integrations:manage');
      return c.json(
        await revisions.applyRevision(
          serviceContext(c),
          actorOf(c.var.auth),
          authority,
          id,
          fileId,
        ),
      );
    },
  );
  register(
    router,
    TAG,
    {
      method: 'delete',
      path: '/{id}/files/{fileId}',
      summary: 'Discard a pending revision',
      params: RevisionParamSchema,
      response: OkSchema,
    },
    async (c) => {
      assertLive(c);
      const { id, fileId } = c.req.valid('param');
      const authority = await connectionAuthority(c, id, 'integrations:manage');
      await revisions.discardRevision(
        serviceContext(c),
        actorOf(c.var.auth),
        authority,
        id,
        fileId,
      );
      return c.json({ ok: true as const });
    },
  );
}

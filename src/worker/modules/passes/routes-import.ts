import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { IdParamSchema, IdSchema, OkSchema } from '../../../shared/contracts/common.ts';
import {
  CheckPassImportSchema,
  CreatePassImportSchema,
  PassImportCommitSchema,
  PassImportEmailRestResultSchema,
  PassImportEmailRestSchema,
  PassImportListQuerySchema,
  PassImportPageSchema,
  PassImportRemoveResultSchema,
  PassImportRemoveSchema,
  PassImportRowsPageSchema,
  PassImportRowsQuerySchema,
  PassImportSchema,
} from '../../../shared/contracts/pass-imports.ts';
import { methodScope } from '../../platform/auth.ts';
import { defaultBodyLimit, limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { actorFor, authOf, requireTenantSessionOrApiKey, svc } from './http.ts';
import { commitImport } from './import-commit.ts';
import { emailRest } from './import-email-rest.ts';
import { errorsCsv, importDto, rowsPage } from './import-read.ts';
import { removeCreated } from './import-remove.ts';
import { resultsCsv } from './import-results.ts';
import {
  checkImport,
  createImport,
  discardImport,
  listImportPage,
  requireImport,
} from './import-service.ts';
import { authorityFor, registerImportMappings } from './routes-import-mappings.ts';

/** Bulk create and update from a file or a sheet link: the check (dry run) and the draft it keeps. */
export const passImportRoutes = createRouter({ bodyLimit: false });
/** The JSON-escaped CSV of the create body has its own cap. */
const CREATE_BODY_BYTES = 3_000_000;
passImportRoutes.use('*', defaultBodyLimit(/\/pass-imports\/?$/));
passImportRoutes.use('/', limitBody(CREATE_BODY_BYTES));
const keyGuard = requireTenantSessionOrApiKey(
  methodScope({ read: 'passes:read', write: 'passes:write' }),
);
// results.csv declares its own scope (passes:write), which the read scope of this guard would stack on.
const importGuard: MiddlewareHandler<AppBindings> = (c, next) =>
  c.req.path.endsWith('/results.csv') ? next() : keyGuard(c, next);
guard(
  passImportRoutes,
  // Removing passes stays with a signed-in user (removeCreated), so the document does not offer it to keys.
  declareKeyAccess(importGuard, {
    read: ['passes:read'],
    write: ['passes:write'],
    only: /^(?!.*\/(?:remove-created|results\.csv)$)/,
  }),
);

const TAG = 'pass-imports';
/** Sessions say which organization they act on; a key bound to an org needs no hint. */
const OrgQuerySchema = z.object({ orgId: IdSchema.optional() });
const ListQuerySchema = PassImportListQuerySchema.extend({ orgId: IdSchema.optional() });
const RowsQuerySchema = PassImportRowsQuerySchema.extend({ orgId: IdSchema.optional() });

registerImportMappings(passImportRoutes);

register(
  passImportRoutes,
  TAG,
  {
    method: 'post',
    path: '/',
    summary: 'Start an import from a file or a sheet link; checks it when a plan is known',
    query: OrgQuerySchema,
    body: CreatePassImportSchema,
    status: 201,
    response: PassImportSchema,
  },
  async (c) => {
    const body = c.req.valid('json');
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
    return idempotentJson(
      c,
      svc(c),
      { orgId: authority.orgId, mode: authority.mode, principal: principalOf(authOf(c)), body },
      201,
      () => createImport(svc(c), authority, body),
    );
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'get',
    path: '/',
    summary: 'Recent imports of this mode',
    query: ListQuerySchema,
    response: PassImportPageSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    const authority = await authorityFor(c, q.orgId, 'passes:read');
    return c.json(await listImportPage(svc(c), authority, q));
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get an import',
    params: IdParamSchema,
    query: OrgQuerySchema,
    response: PassImportSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:read');
    const row = await requireImport(ctx, authority, c.req.valid('param').id);
    return c.json(await importDto(ctx, row));
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/check',
    summary: 'Check the file against a column mapping',
    params: IdParamSchema,
    query: OrgQuerySchema,
    body: CheckPassImportSchema,
    response: PassImportSchema,
  },
  async (c) => {
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
    return c.json(
      await checkImport(svc(c), authority, c.req.valid('param').id, c.req.valid('json').plan),
    );
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/commit',
    summary: 'Apply the checked rows: create the new passes and update the matched ones',
    params: IdParamSchema,
    query: OrgQuerySchema,
    body: PassImportCommitSchema,
    response: PassImportSchema,
  },
  async (c) => {
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
    const body = c.req.valid('json');
    const id = c.req.valid('param').id;
    return idempotentJson(
      c,
      svc(c),
      {
        orgId: authority.orgId,
        mode: authority.mode,
        principal: principalOf(authOf(c)),
        body: { id, ...body },
      },
      200,
      () => commitImport(svc(c), authority, id, body),
      // A replay shows the import as it is now: the commit runs on after the first answer.
      async () => importDto(svc(c), await requireImport(svc(c), authority, id)),
    );
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/rows',
    summary: 'Rows of an import, 100 a page',
    params: IdParamSchema,
    query: RowsQuerySchema,
    response: PassImportRowsPageSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    const ctx = svc(c);
    const authority = await authorityFor(c, q.orgId, 'passes:read');
    const row = await requireImport(ctx, authority, c.req.valid('param').id);
    return c.json(await rowsPage(ctx, row, q));
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/errors.csv',
    summary: 'The rows that failed the check, with a Problem column',
    params: IdParamSchema,
    query: OrgQuerySchema,
  },
  async (c) => {
    const ctx = svc(c);
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:read');
    const row = await requireImport(ctx, authority, c.req.valid('param').id);
    return new Response(await errorsCsv(ctx, row), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="rows-with-errors.csv"',
        'cache-control': 'no-store',
      },
    });
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/results.csv',
    summary: 'What happened to each row, with the pass and its links',
    // The links open the passes, so a key needs the write scope, as for creating them.
    auth: { scope: 'passes:write', capability: 'passes:operate' },
    params: IdParamSchema,
    query: OrgQuerySchema,
  },
  async (c) => {
    const ctx = svc(c);
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
    const row = await requireImport(ctx, authority, c.req.valid('param').id);
    return new Response(await resultsCsv(ctx, row, authority), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="import-results.csv"',
        'cache-control': 'no-store',
      },
    });
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/remove-created',
    summary: 'Remove the passes this import created, 50 a call; edited or scanned ones are skipped',
    params: IdParamSchema,
    query: OrgQuerySchema,
    body: PassImportRemoveSchema,
    response: PassImportRemoveResultSchema,
  },
  async (c) => {
    if (authOf(c).kind !== 'session')
      throw new ForbiddenError('Removing needs a signed-in user.', 'SESSION_REQUIRED');
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
    return c.json(
      await removeCreated(
        svc(c),
        actorFor(c),
        authority,
        c.req.valid('param').id,
        c.req.valid('json').cursor,
      ),
    );
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/email-rest',
    summary:
      'Email the created passes that were not emailed, 50 a call; a repeat emails nobody twice',
    params: IdParamSchema,
    query: OrgQuerySchema,
    body: PassImportEmailRestSchema,
    response: PassImportEmailRestResultSchema,
  },
  async (c) => {
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
    return c.json(
      await emailRest(
        svc(c),
        actorFor(c),
        authority,
        c.req.valid('param').id,
        c.req.valid('json').cursor,
      ),
    );
  },
);

register(
  passImportRoutes,
  TAG,
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Discard a draft that is not committing',
    params: IdParamSchema,
    query: OrgQuerySchema,
    response: OkSchema,
  },
  async (c) => {
    const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
    await discardImport(svc(c), authority, c.req.valid('param').id);
    return c.json({ ok: true as const });
  },
);

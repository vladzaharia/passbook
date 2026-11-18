import { z } from 'zod';
import { IdParamSchema, IdSchema, OkSchema } from '../../../shared/contracts/common.ts';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
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
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  type C,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from './http.ts';
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

/** Bulk create and update from a file or a sheet link: the check (dry run) and the draft it keeps. */
export const passImportRoutes = createRouter({ bodyLimit: false });
/** The JSON-escaped CSV of the create body has its own cap. */
const CREATE_BODY_BYTES = 3_000_000;
passImportRoutes.use('*', defaultBodyLimit(/\/pass-imports\/?$/));
passImportRoutes.use('/', limitBody(CREATE_BODY_BYTES));
guard(
  passImportRoutes,
  requireTenantSessionOrApiKey(methodScope({ read: 'passes:read', write: 'passes:write' })),
);

const TAG = 'pass-imports';
/** Sessions say which organization they act on; a key bound to an org needs no hint. */
const OrgQuerySchema = z.object({ orgId: IdSchema.optional() });
const ListQuerySchema = PassImportListQuerySchema.extend({ orgId: IdSchema.optional() });
const RowsQuerySchema = PassImportRowsQuerySchema.extend({ orgId: IdSchema.optional() });

async function authorityFor(c: C, orgId: string | undefined, capability: OrgCapability) {
  const auth = authOf(c);
  const org = orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
  if (!org) throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
  assertOrg(c, org);
  return tenantAuthorityOf(svc(c), auth, org, capability);
}

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
    return c.json(await createImport(svc(c), authority, body), 201);
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
    return c.json(
      await commitImport(svc(c), authority, c.req.valid('param').id, c.req.valid('json')),
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

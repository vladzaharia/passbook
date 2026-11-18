import { z } from 'zod';
import { IdParamSchema, IdSchema, OkSchema } from '../../../shared/contracts/common.ts';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import {
  CheckPassImportSchema,
  CreatePassImportSchema,
  PassImportListQuerySchema,
  PassImportPageSchema,
  PassImportRowsPageSchema,
  PassImportRowsQuerySchema,
  PassImportSchema,
} from '../../../shared/contracts/pass-imports.ts';
import { methodScope } from '../../platform/auth.ts';
import { defaultBodyLimit, limitBody } from '../../platform/body-limit.ts';
import { ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import {
  assertOrg,
  authOf,
  type C,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from './http.ts';
import { errorsCsv, importDto, rowsPage } from './import-read.ts';
import { checkImport, createImport, discardImport, requireImport } from './import-service.ts';
import { listImports } from './repo-imports.ts';

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
    const ctx = svc(c);
    const authority = await authorityFor(c, q.orgId, 'passes:read');
    const [createdAt, id] = (q.cursor ?? '').split(':');
    const cursor =
      createdAt && id && Number.isSafeInteger(Number(createdAt))
        ? { createdAt: Number(createdAt), id }
        : null;
    const rows = await listImports(
      ctx.env.DB,
      authority.orgId,
      authority.mode,
      q.limit + 1,
      cursor,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({
      items: await Promise.all(page.map((r) => importDto(ctx, r, { light: true }))),
      nextCursor: rows.length > q.limit && last ? `${last.created_at}:${last.id}` : null,
    });
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

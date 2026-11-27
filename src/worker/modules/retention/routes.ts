import { CursorQuerySchema, OkSchema } from '../../../shared/contracts/common.ts';
import {
  HoldIdParamsSchema,
  HoldListSchema,
  HoldParamsSchema,
  PlaceHoldSchema,
  PlatformReceiptParamsSchema,
  ReceiptFileSchema,
  ReceiptIdParamsSchema,
  ReceiptListQuerySchema,
  ReceiptListSchema,
} from '../../../shared/contracts/retention.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { byUserOfCaller } from '../idp/actor.ts';
import { requireNotPersonalFor } from '../orgs/personal-guard.ts';
import { authOf, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { listHoldViews, listReceiptItems, receiptFile } from './console.ts';
import { type HoldBy, placeHold, releaseHold } from './holds.ts';

type C = Parameters<typeof authOf>[0];

const sessionOf = (c: C) => {
  const auth = authOf(c);
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

/** An org member with the capability; the grant re-checks it at commit. */
async function orgBy(c: C, orgId: string, capability: 'audit:read' | 'org:manage') {
  const authority = await tenantAuthorityOf(serviceContext(c), sessionOf(c), orgId, capability);
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

/** The release of a hold is a person's: this is the signed-in admin. */
export const platformBy = (c: C): HoldBy => {
  const auth = sessionOf(c);
  return { kind: 'platform', admin: { userId: auth.userId, sessionId: auth.sessionId } };
};

/** A platform admin, or a Platform key with `platform:orgs`; a key's `placed_by` column names its creator. */
const platformPlaceBy = async (c: C): Promise<HoldBy> => {
  const admin = platformActorOf(c, { scope: 'platform:orgs' });
  return { kind: 'platform', admin, user: await byUserOfCaller(c.env.DB, admin) };
};

/** A key is nobody's owner: a personal org's holds and receipts are not its to read or place. */
const keyNotPersonal = async (c: C, orgId: string) => {
  if (platformActorOf(c).keyId) await requireNotPersonalFor(c.env.DB, orgId, '');
};

const download = (c: C, name: string) =>
  c.header('content-disposition', `attachment; filename="${name}"`);

/**
 * Mount at /api/v1/orgs. Reading holds and receipts needs `audit:read`; placing and releasing an org hold
 * needs `org:manage`. A hold PassBook placed is listed read-only and an org cannot release it.
 */
export const retentionRoutes = createRouter();
guard(retentionRoutes, requireTenantSession);
retentionRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  retentionRoutes,
  'retention',
  {
    method: 'get',
    path: '/{orgId}/retention/holds',
    summary: 'List legal holds',
    params: HoldParamsSchema,
    query: CursorQuerySchema,
    response: HoldListSchema,
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    await orgBy(c, orgId, 'audit:read');
    return c.json({
      items: await listHoldViews(serviceContext(c).env.DB, orgId, 'org'),
      nextCursor: null,
    });
  },
);

register(
  retentionRoutes,
  'retention',
  {
    method: 'post',
    path: '/{orgId}/retention/holds',
    summary: 'Place a legal hold on the organization or one pass',
    params: HoldParamsSchema,
    body: PlaceHoldSchema,
    response: OkSchema,
    status: 201,
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    const authority = await orgBy(c, orgId, 'org:manage');
    await placeHold(serviceContext(c), orgId, c.req.valid('json'), { kind: 'org', authority });
    return c.json({ ok: true as const }, 201);
  },
);

register(
  retentionRoutes,
  'retention',
  {
    method: 'post',
    path: '/{orgId}/retention/holds/{holdId}/release',
    summary: 'Release a legal hold the organization placed',
    params: HoldIdParamsSchema,
    response: OkSchema,
    // A person's call, never a key's: releasing a hold lets a purge run.
    auth: { human: true, requestMode: true },
  },
  async (c) => {
    const { orgId, holdId } = c.req.valid('param');
    const authority = await orgBy(c, orgId, 'org:manage');
    await releaseHold(serviceContext(c), orgId, holdId, { kind: 'org', authority });
    return c.json({ ok: true as const });
  },
);

register(
  retentionRoutes,
  'retention',
  {
    method: 'get',
    path: '/{orgId}/retention/receipts',
    summary: 'List retention receipts',
    params: HoldParamsSchema,
    query: ReceiptListQuerySchema,
    response: ReceiptListSchema,
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    await orgBy(c, orgId, 'audit:read');
    return c.json(await listReceiptItems(serviceContext(c), orgId, c.req.valid('query')));
  },
);

register(
  retentionRoutes,
  'retention',
  {
    method: 'get',
    path: '/{orgId}/retention/receipts/{receiptId}/download',
    summary: 'Download one retention receipt',
    params: ReceiptIdParamsSchema,
    response: ReceiptFileSchema,
  },
  async (c) => {
    const { orgId, receiptId } = c.req.valid('param');
    await orgBy(c, orgId, 'audit:read');
    const file = await receiptFile(serviceContext(c), orgId, receiptId);
    download(c, `retention-receipt-${receiptId}.json`);
    return c.json(file);
  },
);

/** Mount at /api/v1/platform: a platform administrator places holds an org cannot release. */
export const retentionPlatformRoutes = createRouter();
retentionPlatformRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  retentionPlatformRoutes,
  'retention',
  {
    method: 'get',
    auth: { platform: 'platform:orgs', key: true },
    path: '/orgs/{orgId}/retention/holds',
    summary: 'List the legal holds of an organization',
    params: HoldParamsSchema,
    query: CursorQuerySchema,
    response: HoldListSchema,
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    await keyNotPersonal(c, orgId);
    return c.json({
      items: await listHoldViews(serviceContext(c).env.DB, orgId, 'platform'),
      nextCursor: null,
    });
  },
);

register(
  retentionPlatformRoutes,
  'retention',
  {
    method: 'post',
    auth: { platform: 'platform:orgs', key: true },
    path: '/orgs/{orgId}/retention/holds',
    summary: 'Place a platform legal hold; only a platform administrator releases it',
    params: HoldParamsSchema,
    body: PlaceHoldSchema,
    response: OkSchema,
    status: 201,
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    await keyNotPersonal(c, orgId);
    await placeHold(serviceContext(c), orgId, c.req.valid('json'), await platformPlaceBy(c));
    return c.json({ ok: true as const }, 201);
  },
);

register(
  retentionPlatformRoutes,
  'retention',
  {
    method: 'get',
    auth: { platform: 'platform:orgs', key: true },
    path: '/orgs/{orgId}/retention/receipts',
    summary: 'List the retention receipts of an organization',
    params: HoldParamsSchema,
    query: ReceiptListQuerySchema,
    response: ReceiptListSchema,
  },
  async (c) => {
    const { orgId } = c.req.valid('param');
    await keyNotPersonal(c, orgId);
    return c.json(await listReceiptItems(serviceContext(c), orgId, c.req.valid('query')));
  },
);

register(
  retentionPlatformRoutes,
  'retention',
  {
    method: 'get',
    auth: { platform: 'platform:orgs', key: true },
    path: '/orgs/{orgId}/retention/receipts/{receiptId}/download',
    summary: 'Download one retention receipt of an organization',
    params: ReceiptIdParamsSchema,
    response: ReceiptFileSchema,
  },
  async (c) => {
    const { orgId, receiptId } = c.req.valid('param');
    await keyNotPersonal(c, orgId);
    download(c, `retention-receipt-${receiptId}.json`);
    return c.json(await receiptFile(serviceContext(c), orgId, receiptId));
  },
);

/** Deletions of the platform pass's own records (no organization): administrators and Platform keys. */
register(
  retentionPlatformRoutes,
  'retention',
  {
    method: 'get',
    auth: { platform: 'platform:orgs', key: true },
    path: '/retention/receipts',
    summary: 'List retention receipts of platform-scope deletions',
    query: ReceiptListQuerySchema,
    response: ReceiptListSchema,
  },
  async (c) => c.json(await listReceiptItems(serviceContext(c), null, c.req.valid('query'))),
);

register(
  retentionPlatformRoutes,
  'retention',
  {
    method: 'get',
    auth: { platform: 'platform:orgs', key: true },
    path: '/retention/receipts/{receiptId}/download',
    summary: 'Download one platform-scope retention receipt',
    params: PlatformReceiptParamsSchema,
    response: ReceiptFileSchema,
  },
  async (c) => {
    const { receiptId } = c.req.valid('param');
    download(c, `retention-receipt-${receiptId}.json`);
    return c.json(await receiptFile(serviceContext(c), null, receiptId));
  },
);

import {
  CreateScanEventSchema,
  IdParamSchema,
  pageOf,
  ScanEventAssignSchema,
  ScanEventListQuerySchema,
  ScanEventSchema,
  UpdateScanEventSchema,
} from '../../../shared/contracts/index.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority, eventTarget, eventView, listEvents } from './events.ts';
import { archiveEvent, assignScanners, createEvent, updateEvent } from './events-mutations.ts';
import { orgOf } from './key-credentials.ts';

type Router = ReturnType<typeof createRouter>;
const TAG = 'scan-events';
const AUTH = {
  scope: 'scanning:write',
  capability: 'scanning:manage',
  feature: 'scanning.devices',
} as const;

/**
 * The caller's authority for an org: a console session captures its membership, a key writes under
 * its own principal (the grant re-checks the key at commit). A key bound to another org finds
 * no such org.
 */
async function writer(
  c: C,
  orgId: string,
  missing: () => NotFoundError,
  capability: 'scanning:read' | 'scanning:manage' = 'scanning:manage',
) {
  const ctx = serviceContext(c);
  const auth = c.var.auth as SessionAuth | ApiKeyAuth | undefined;
  if (auth?.kind === 'api_key') {
    if (auth.orgId !== orgId) throw missing();
    const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
    if (authority.kind !== 'api_key') throw new ForbiddenError();
    return { ctx, auth, actorId: auth.keyId, authority };
  }
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (!(await getOrgAccess(ctx, auth.userId, orgId))) throw missing();
  const authority = await captureEventAuthority(
    ctx,
    auth,
    await tenantAuthorityOf(ctx, auth, orgId, capability),
  );
  return { ctx, auth, actorId: auth.userId, authority };
}

const noOrg = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
const noEvent = () => new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');

async function byId(
  c: C,
  id: string,
  capability: 'scanning:read' | 'scanning:manage' = 'scanning:manage',
) {
  const event = await eventTarget(serviceContext(c), id);
  const auth = c.var.auth;
  if (!event || (auth && event.mode !== (auth as { mode?: string }).mode)) throw noEvent();
  return writer(c, event.orgId, noEvent, capability);
}

/** No `capability` on a read: a caller outside the org gets an empty page, so the handler does not always prove either. */
const READ = { scope: 'scan-setup:read' } as const;

export function registerEventWrites(router: Router): void {
  router.use('*', limitBody(64 * 1024));
  register(
    router,
    TAG,
    {
      method: 'get',
      path: '/',
      summary: 'List scan events',
      auth: READ,
      query: ScanEventListQuerySchema,
      response: pageOf(ScanEventSchema),
    },
    async (c) => {
      const given = c.req.valid('query');
      const auth = c.var.auth;
      // One decision for every scan list that takes an org (see `orgOf`).
      const orgId = orgOf(auth, given.orgId);
      const query = { ...given, orgId };
      let w: Awaited<ReturnType<typeof writer>>;
      try {
        w = await writer(c, orgId, noOrg, 'scanning:read');
      } catch (e) {
        if (e instanceof NotFoundError) return c.json({ items: [], nextCursor: null });
        throw e;
      }
      return c.json(await listEvents(w.ctx, w.auth.mode, query, w.authority));
    },
  );
  register(
    router,
    TAG,
    {
      method: 'get',
      path: '/{id}',
      summary: 'Get a scan event',
      auth: READ,
      params: IdParamSchema,
      response: ScanEventSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const w = await byId(c, id, 'scanning:read');
      return c.json(await eventView(w.ctx, id, w.authority));
    },
  );
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/',
      summary: 'Create a scan event',
      auth: AUTH,
      body: CreateScanEventSchema,
      status: 201,
      response: ScanEventSchema,
    },
    async (c) => {
      const input = c.req.valid('json');
      const w = await writer(c, input.orgId, noOrg);
      return c.json(await createEvent(w.ctx, w.actorId, w.auth.mode, input, w.authority), 201);
    },
  );
  register(
    router,
    TAG,
    {
      method: 'patch',
      path: '/{id}',
      summary: 'Edit a scan event',
      auth: AUTH,
      params: IdParamSchema,
      body: UpdateScanEventSchema,
      response: ScanEventSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const w = await byId(c, id);
      return c.json(await updateEvent(w.ctx, w.actorId, id, c.req.valid('json'), w.authority));
    },
  );
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/{id}/archive',
      summary: 'Archive a scan event (its scanners are detached)',
      auth: AUTH,
      params: IdParamSchema,
      response: ScanEventSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const w = await byId(c, id);
      return c.json(await archiveEvent(w.ctx, w.actorId, id, w.authority));
    },
  );
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/{id}/scanners',
      summary: 'Move scanners onto a scan event',
      auth: AUTH,
      params: IdParamSchema,
      body: ScanEventAssignSchema,
      response: ScanEventSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const w = await byId(c, id);
      return c.json(await assignScanners(w.ctx, w.actorId, id, c.req.valid('json'), w.authority));
    },
  );
}

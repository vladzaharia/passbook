import {
  CreateScanEventSchema,
  IdParamSchema,
  ScanEventSchema,
  UpdateScanEventSchema,
} from '../../../shared/contracts/index.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority, eventTarget } from './events.ts';
import { archiveEvent, createEvent, updateEvent } from './events-mutations.ts';

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
async function writer(c: C, orgId: string, missing: () => NotFoundError) {
  const ctx = serviceContext(c);
  const auth = c.var.auth as SessionAuth | ApiKeyAuth | undefined;
  if (auth?.kind === 'api_key') {
    if (auth.orgId !== null && auth.orgId !== orgId) throw missing();
    return {
      ctx,
      auth,
      actorId: auth.keyId,
      authority: await tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage'),
    };
  }
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  if (!(await getOrgAccess(ctx, auth.userId, orgId))) throw missing();
  const authority = await captureEventAuthority(
    ctx,
    auth,
    await tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage'),
  );
  return { ctx, auth, actorId: auth.userId, authority };
}

const noOrg = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
const noEvent = () => new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');

async function byId(c: C, id: string) {
  const event = await eventTarget(serviceContext(c), id);
  const auth = c.var.auth;
  if (!event || (auth && event.mode !== (auth as { mode?: string }).mode)) throw noEvent();
  return writer(c, event.orgId, noEvent);
}

export function registerEventWrites(router: Router): void {
  router.use('*', limitBody(64 * 1024));
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
      return c.json(
        await createEvent(w.ctx, w.actorId, w.auth.mode, input, w.authority),
        201,
      );
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
}

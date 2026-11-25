import { CursorQuerySchema, IdParamSchema, OkSchema } from '../../../shared/contracts/common.ts';
import {
  DeveloperInvitationListSchema,
  DeveloperInvitationParamSchema,
  DeveloperInvitationSchema,
  DeveloperListSchema,
  DeveloperParamSchema,
  InviteDeveloperSchema,
} from '../../../shared/contracts/developer-invitations.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { authOf } from '../passes/http.ts';
import {
  inviteDeveloper,
  listDeveloperInvitations,
  revokeDeveloperInvitation,
} from './service-invite.ts';
import { listDevelopers, removeDeveloper } from './service-remove.ts';

const TAG = 'developer invitations';
/** The invitation reaches the identity provider and a removal ends access: a session needs a recent sign-in, a key is never asked. */
const WRITE = {
  scope: 'members:write',
  capability: 'members:manage',
  stepUp: { maxAgeSec: STEP_UP_SECONDS },
} as const;
const READ = { scope: 'members:read', capability: 'members:read' } as const;

/** Mount at /api/v1/orgs. A developer invitation is `members:manage`, or a Live key naming `members:write`. */
export const developerOrgRoutes = createRouter();
// Only these four paths: this router is mounted over every /orgs path, and the rest set their own cache headers.
for (const path of [
  '/:id/developer-invitations',
  '/:id/developer-invitations/:invitationId',
  '/:id/developers',
  '/:id/developers/:userId',
])
  developerOrgRoutes.use(path, async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

register(
  developerOrgRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/developer-invitations',
    summary: 'Invite a developer',
    auth: WRITE,
    params: IdParamSchema,
    body: InviteDeveloperSchema,
    response: DeveloperInvitationSchema,
    status: 201,
  },
  (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const ctx = serviceContext(c);
    const auth = authOf(c);
    return idempotentJson(
      c,
      ctx,
      { orgId: id, mode: 'live', principal: principalOf(auth), body },
      201,
      () => inviteDeveloper(ctx, auth, id, body),
    );
  },
);

register(
  developerOrgRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/developer-invitations',
    summary: 'List developer invitations',
    auth: READ,
    params: IdParamSchema,
    query: CursorQuerySchema,
    response: DeveloperInvitationListSchema,
  },
  async (c) =>
    c.json(await listDeveloperInvitations(serviceContext(c), authOf(c), c.req.valid('param').id)),
);

register(
  developerOrgRoutes,
  TAG,
  {
    method: 'delete',
    path: '/{id}/developer-invitations/{invitationId}',
    summary: 'Revoke a developer invitation',
    auth: { scope: 'members:write', capability: 'members:manage' },
    params: DeveloperInvitationParamSchema,
    response: OkSchema,
  },
  async (c) => {
    const { id, invitationId } = c.req.valid('param');
    await revokeDeveloperInvitation(serviceContext(c), authOf(c), id, invitationId);
    return c.json({ ok: true as const });
  },
);

register(
  developerOrgRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/developers',
    summary: 'List the developers an organization vouches for',
    auth: READ,
    params: IdParamSchema,
    query: CursorQuerySchema,
    response: DeveloperListSchema,
  },
  async (c) => c.json(await listDevelopers(serviceContext(c), authOf(c), c.req.valid('param').id)),
);

register(
  developerOrgRoutes,
  TAG,
  {
    method: 'delete',
    path: '/{id}/developers/{userId}',
    summary: 'Remove a developer',
    auth: WRITE,
    params: DeveloperParamSchema,
    response: OkSchema,
  },
  async (c) => {
    const { id, userId } = c.req.valid('param');
    await removeDeveloper(serviceContext(c), authOf(c), id, userId);
    return c.json({ ok: true as const });
  },
);

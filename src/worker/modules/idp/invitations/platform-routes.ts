import { CursorQuerySchema, IdParamSchema, OkSchema } from '../../../../shared/contracts/common.ts';
import {
  CreatePlatformInvitationSchema,
  PlatformInvitationCreatedSchema,
  PlatformInvitationListSchema,
} from '../../../../shared/contracts/platform-invitations.ts';
import { currentUserId } from '../../../platform/auth.ts';
import { idempotentJson } from '../../../platform/idempotency.ts';
import { createRouter, register } from '../../../platform/openapi.ts';
import { serviceContext } from '../../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../../platform/sign-in-guard.ts';
import {
  createPlatformInvitation,
  listPlatformInvitations,
  resendPlatformInvitation,
  revokePlatformInvitation,
} from './platform-service.ts';

const TAG = 'platform invitations';
/** A platform invitation puts a person in groups other apps trust: platform admins only, signed in with Polaris ID, step-up to write. */
const READ = { platform: 'platform:users', signIn: 'oidc' } as const;
const WRITE = { ...READ, stepUp: { maxAgeSec: STEP_UP_SECONDS } } as const;
/** Idempotency keys are per org; a platform write has none. */
const SCOPE = { orgId: 'platform', mode: 'live' } as const;

/** Mount at /api/v1/platform. */
export const platformInvitationRoutes = createRouter();
platformInvitationRoutes.use('/invitations/*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  platformInvitationRoutes,
  TAG,
  {
    method: 'post',
    path: '/invitations',
    summary: 'Invite a person to Polaris ID groups',
    auth: WRITE,
    body: CreatePlatformInvitationSchema,
    response: PlatformInvitationCreatedSchema,
    status: 201,
    codes: ['IDP_DRY_RUN', 'IDP_UNAVAILABLE', 'PLATFORM_INVITE_PENDING'],
  },
  (c) => {
    const body = c.req.valid('json');
    const ctx = serviceContext(c);
    const actor = currentUserId(c);
    return idempotentJson(c, ctx, { ...SCOPE, principal: `session:${actor}`, body }, 201, () =>
      createPlatformInvitation(ctx, actor, body),
    );
  },
);

register(
  platformInvitationRoutes,
  TAG,
  {
    method: 'get',
    path: '/invitations',
    summary: 'List platform invitations',
    auth: READ,
    query: CursorQuerySchema,
    response: PlatformInvitationListSchema,
  },
  async (c) => c.json(await listPlatformInvitations(serviceContext(c))),
);

register(
  platformInvitationRoutes,
  TAG,
  {
    method: 'delete',
    path: '/invitations/{id}',
    summary: 'Revoke a platform invitation',
    auth: WRITE,
    params: IdParamSchema,
    response: OkSchema,
    codes: ['PLATFORM_INVITE_CONFLICT'],
  },
  async (c) => {
    await revokePlatformInvitation(serviceContext(c), currentUserId(c), c.req.valid('param').id);
    return c.json({ ok: true as const });
  },
);

register(
  platformInvitationRoutes,
  TAG,
  {
    method: 'post',
    path: '/invitations/{id}/resend',
    summary: 'Send a platform invitation again with a new link',
    auth: WRITE,
    params: IdParamSchema,
    response: PlatformInvitationCreatedSchema,
    status: 201,
    codes: ['IDP_DRY_RUN', 'IDP_UNAVAILABLE', 'PLATFORM_INVITE_CONFLICT'],
  },
  (c) => {
    const { id } = c.req.valid('param');
    const ctx = serviceContext(c);
    const actor = currentUserId(c);
    return idempotentJson(
      c,
      ctx,
      { ...SCOPE, principal: `session:${actor}`, body: { id } },
      201,
      () => resendPlatformInvitation(ctx, actor, id),
    );
  },
);

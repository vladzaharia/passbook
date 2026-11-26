import {
  InvitationAcceptSchema,
  InvitationChallengeSchema,
  InvitationClaimSchema,
  InvitationConfirmSchema,
  InvitationPreviewSchema,
  InvitationSetupSchema,
  InvitationTokenSchema,
} from '../../../../shared/contracts/invitations.ts';
import { inviteKindOf } from '../../../../shared/invitation-link.ts';
import { UnauthenticatedError } from '../../../platform/errors.ts';
import { createRouter, register } from '../../../platform/openapi.ts';
import { clientIp, clientRatePrefix, enforceRateLimit } from '../../../platform/rate-limit.ts';
import { serviceContext } from '../../../platform/service-context.ts';
import { idpReady } from '../../dev-access/availability.ts';
import { acceptInvitation } from './accept.ts';
import { challengeNeeds, invalidInvitation } from './challenge.ts';
import { claimExisting } from './claim-existing.ts';
import {
  acceptPlatformInvite,
  claimExistingPlatform,
  confirmPlatform,
  previewPlatform,
  setupPlatform,
} from './platform-flow.ts';
import { resolvePlatform } from './platform-resolve.ts';
import { maskEmail, resolveInvite } from './resolve.ts';
import { setupInvitation } from './setup.ts';

const TAG = 'invitations';
const isPlatform = (token: string) => inviteKindOf(token) === 'platform';

/**
 * Mount at /api/v1/invitations: the one invitation page's calls for every kind. The secret in the body is the
 * credential for the three public calls; accepting needs a strong Polaris ID session and CSRF. Nothing here is
 * cached, and the fragment the secret rides in never reaches a server, a log or a Referer.
 */
export const invitationRoutes = createRouter();
invitationRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  invitationRoutes,
  TAG,
  {
    method: 'post',
    path: '/preview',
    summary: 'Name what an invitation link joins',
    public: true,
    body: InvitationTokenSchema,
    response: InvitationPreviewSchema,
    codes: ['INVITATION_INVALID'],
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_PUBLIC', `invitation:${clientRatePrefix(c)}`);
    const ctx = serviceContext(c);
    const { token } = c.req.valid('json');
    if (isPlatform(token)) {
      const platform = await resolvePlatform(ctx, token);
      if (platform?.state !== 'pending') throw invalidInvitation();
      return c.json(await previewPlatform(ctx, platform));
    }
    const invite = await resolveInvite(ctx, token);
    if (invite?.state !== 'pending') throw invalidInvitation();
    return c.json({
      kind: invite.kind,
      orgName: invite.row.org_name,
      groups: [],
      roles: invite.roles,
      developer: invite.developer,
      email: maskEmail(invite.row.email),
      expiresAt: invite.row.expires_at,
      polaris: !invite.late && (await idpReady(ctx, challengeNeeds(invite))),
    });
  },
);

register(
  invitationRoutes,
  TAG,
  {
    method: 'post',
    path: '/setup',
    summary: 'Make a one-hour link to create a Polaris ID with the invitation’s groups',
    public: true,
    body: InvitationChallengeSchema,
    response: InvitationSetupSchema,
    codes: ['INVITATION_INVALID', 'INVITATION_SETUP_CAPPED', 'TURNSTILE_FAILED', 'IDP_UNAVAILABLE'],
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_LOGIN', `invitation:${clientRatePrefix(c)}`);
    const input = c.req.valid('json');
    const ctx = serviceContext(c);
    return c.json(
      isPlatform(input.token)
        ? await setupPlatform(ctx, clientIp(c), input)
        : await setupInvitation(ctx, clientIp(c), input),
    );
  },
);

register(
  invitationRoutes,
  TAG,
  {
    method: 'post',
    path: '/claim-existing',
    summary: 'Give the Polaris ID account that has the invited address the invitation’s groups',
    public: true,
    body: InvitationChallengeSchema,
    response: InvitationClaimSchema,
    codes: [
      'INVITATION_INVALID',
      'INVITATION_NO_ACCOUNT',
      'INVITATION_CLAIM_CAPPED',
      'TURNSTILE_FAILED',
      'IDP_UNAVAILABLE',
    ],
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_LOGIN', `invitation:${clientRatePrefix(c)}`);
    const input = c.req.valid('json');
    const ctx = serviceContext(c);
    if (isPlatform(input.token)) await claimExistingPlatform(ctx, clientIp(c), input);
    else await claimExisting(ctx, clientIp(c), input);
    return c.json({ ok: true as const });
  },
);

register(
  invitationRoutes,
  TAG,
  {
    method: 'post',
    path: '/accept',
    summary: 'Accept an invitation with a verified account email',
    auth: { human: true, signIn: 'strict' },
    body: InvitationTokenSchema,
    response: InvitationAcceptSchema,
    codes: [
      'INVITATION_INVALID',
      'INVITATION_EMAIL_MISMATCH',
      'INVITATION_CONFLICT',
      'DEVELOPER_LIMIT_REACHED',
      'IDP_SIGN_IN_REQUIRED',
    ],
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(c.env, 'RL_LOGIN', `invitation-accept:${auth.userId}`);
    const ctx = serviceContext(c);
    const { token } = c.req.valid('json');
    return c.json(
      isPlatform(token)
        ? await acceptPlatformInvite(ctx, auth, token)
        : await acceptInvitation(ctx, auth, token),
    );
  },
);

register(
  invitationRoutes,
  TAG,
  {
    method: 'post',
    path: '/confirm',
    summary:
      'Finish a platform invitation after creating a Polaris ID, if its address matches the invitation',
    public: true,
    body: InvitationTokenSchema,
    response: InvitationConfirmSchema,
    codes: [
      'INVITATION_INVALID',
      'INVITATION_EMAIL_MISMATCH',
      'INVITATION_EMAIL_UNVERIFIED',
      'INVITATION_NOT_STARTED',
      'INVITATION_CONFLICT',
      'IDP_SIGN_IN_REQUIRED',
    ],
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_LOGIN', `invitation:${clientRatePrefix(c)}`);
    const { token } = c.req.valid('json');
    if (!isPlatform(token)) throw invalidInvitation();
    return c.json(await confirmPlatform(serviceContext(c), token));
  },
);

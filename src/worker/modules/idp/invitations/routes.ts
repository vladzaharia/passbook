import {
  InvitationAcceptSchema,
  InvitationChallengeSchema,
  InvitationClaimSchema,
  InvitationPreviewSchema,
  InvitationSetupSchema,
  InvitationTokenSchema,
} from '../../../../shared/contracts/invitations.ts';
import { UnauthenticatedError } from '../../../platform/errors.ts';
import { createRouter, register } from '../../../platform/openapi.ts';
import { clientIp, clientRatePrefix, enforceRateLimit } from '../../../platform/rate-limit.ts';
import { serviceContext } from '../../../platform/service-context.ts';
import { idpReady } from '../../dev-access/availability.ts';
import { acceptInvitation } from './accept.ts';
import { challengeNeeds, invalidInvitation } from './challenge.ts';
import { claimExisting } from './claim-existing.ts';
import { maskEmail, resolveInvite } from './resolve.ts';
import { setupInvitation } from './setup.ts';

const TAG = 'invitations';

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
    const invite = await resolveInvite(ctx, c.req.valid('json').token);
    if (invite?.state !== 'pending') throw invalidInvitation();
    return c.json({
      kind: invite.kind,
      orgName: invite.row.org_name,
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
    return c.json(await setupInvitation(serviceContext(c), clientIp(c), c.req.valid('json')));
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
    await claimExisting(serviceContext(c), clientIp(c), c.req.valid('json'));
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
    return c.json(await acceptInvitation(serviceContext(c), auth, c.req.valid('json').token));
  },
);

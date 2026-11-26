import type { Context } from 'hono';
import {
  AcceptOrgInvitationSchema,
  ChangeOrgMemberRolesSchema,
  CursorQuerySchema,
  IdParamSchema,
  InviteOrgMemberSchema,
  OkSchema,
  OrgInvitationListSchema,
  OrgInvitationParamSchema,
  OrgInvitationPreviewSchema,
  OrgInvitationSchema,
  OrgMemberListSchema,
  OrgMemberSchema,
  OrgMembershipListSchema,
  OrgMembershipParamSchema,
  OrgMembershipSchema,
} from '../../../shared/contracts/index.ts';
import {
  requireConsoleSession,
  requireHolderSession,
  requireStrictSession,
  type SessionAuth,
} from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { ADMINISTERING_ROLES } from '../../platform/org-role-grants.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { peekBody, requireStepUp, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestTheme } from '../../ssr/head.ts';
import { acceptInvitation } from '../idp/invitations/accept.ts';
import { listMyOrgMemberships, parseRoles } from './access.ts';
import { invitationPage } from './invitation-page.ts';
import { changeOrgMemberRoles, resendOrgInvitation } from './membership-replace.ts';
import {
  inviteOrgMember,
  isOrgManager,
  listOrgInvitations,
  listOrgMembers,
  previewOrgInvitation,
  revokeOrgInvitation,
  revokeOrgMembership,
} from './membership-service.ts';
import { invitationById } from './repo-members.ts';

const session = (c: Context<AppBindings>): SessionAuth => {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

export const membershipRoutes = createRouter({ bodyLimit: false });

// The old landing address, still in mailed links: it opens the invitation page, carrying the fragment on.
// The accepting POST is always strong-session (no email-link grace) and CSRF protected.
membershipRoutes.use('/invitations/accept', (c, next) =>
  c.req.method === 'GET' ? next() : requireStrictSession(c, next),
);
// The caller's own list is read by the account menu and the setup banner; an email link may read it.
membershipRoutes.use('/memberships/me', requireHolderSession);
membershipRoutes.use('/:id/memberships', requireConsoleSession);
membershipRoutes.use('/:id/memberships/:membershipId', requireConsoleSession);
membershipRoutes.use('/:id/invitations', requireConsoleSession);
// Inviting someone into a role that administers the org (or mints keys) hands over its credentials.
membershipRoutes.post(
  '/:id/invitations',
  requireStepUp(STEP_UP_SECONDS, async (c) => {
    const { roles } = await peekBody(c);
    return (
      Array.isArray(roles) &&
      roles.some((role) => (ADMINISTERING_ROLES as readonly unknown[]).includes(role))
    );
  }),
);
// Giving a member a role that administers the org hands over its credentials, as inviting does.
membershipRoutes.patch(
  '/:id/memberships/:membershipId',
  requireStepUp(STEP_UP_SECONDS, async (c) => {
    const { roles } = await peekBody(c);
    return (
      Array.isArray(roles) &&
      roles.some((role) => (ADMINISTERING_ROLES as readonly unknown[]).includes(role))
    );
  }),
);
membershipRoutes.use('/:id/invitations/:invitationId', requireConsoleSession);
membershipRoutes.use('/:id/invitations/:invitationId/resend', requireConsoleSession);
// A resend mails a fresh credential link: for an invitation into an administering role it asks as inviting did.
membershipRoutes.post(
  '/:id/invitations/:invitationId/resend',
  requireStepUp(STEP_UP_SECONDS, async (c) => {
    const orgId = c.req.param('id') ?? '';
    // Only a manager of the org learns anything from whether this asks.
    if (!(await isOrgManager(serviceContext(c), session(c), orgId))) return false;
    const found = await invitationById(c.env.DB, orgId, c.req.param('invitationId') ?? '');
    if (!found) return false;
    try {
      return parseRoles(found.roles).some((role) =>
        (ADMINISTERING_ROLES as readonly unknown[]).includes(role),
      );
    } catch {
      return true;
    }
  }),
);

register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'get',
    path: '/invitations/accept',
    summary: 'Open an organization invitation',
  },
  (c) => invitationPage(c.var.nonce, requestTheme(c)),
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'post',
    path: '/invitations/accept',
    summary: 'Accept an invitation with a verified account email',
    body: AcceptOrgInvitationSchema,
    response: OrgMembershipSchema,
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_LOGIN', `invitation-accept:${session(c).userId}`);
    const accepted = await acceptInvitation(
      serviceContext(c),
      session(c),
      c.req.valid('json').token,
      'member',
    );
    return c.json(accepted.membership as NonNullable<typeof accepted.membership>);
  },
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'post',
    path: '/invitations/preview',
    summary: 'Name the organization an invitation link joins',
    body: AcceptOrgInvitationSchema,
    response: OrgInvitationPreviewSchema,
  },
  async (c) => c.json(await previewOrgInvitation(serviceContext(c), c.req.valid('json').token)),
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'get',
    path: '/memberships/me',
    summary: 'List my active organization memberships',
    query: CursorQuerySchema,
    response: OrgMembershipListSchema,
  },
  async (c) =>
    c.json({
      items: await listMyOrgMemberships(serviceContext(c), session(c).userId),
      nextCursor: null,
    }),
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'get',
    path: '/{id}/memberships',
    summary: 'List organization memberships',
    params: IdParamSchema,
    query: CursorQuerySchema,
    response: OrgMemberListSchema,
  },
  async (c) =>
    c.json({
      items: await listOrgMembers(serviceContext(c), session(c), c.req.valid('param').id),
      nextCursor: null,
    }),
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'get',
    path: '/{id}/invitations',
    summary: 'List organization invitations',
    params: IdParamSchema,
    query: CursorQuerySchema,
    response: OrgInvitationListSchema,
  },
  async (c) =>
    c.json({
      items: await listOrgInvitations(serviceContext(c), session(c), c.req.valid('param').id),
      nextCursor: null,
    }),
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'post',
    path: '/{id}/invitations',
    summary: 'Invite an organization member',
    params: IdParamSchema,
    body: InviteOrgMemberSchema,
    status: 201,
    response: OrgInvitationSchema,
  },
  async (c) =>
    c.json(
      await inviteOrgMember(
        serviceContext(c),
        session(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
      201,
    ),
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'delete',
    path: '/{id}/invitations/{invitationId}',
    summary: 'Revoke an organization invitation',
    params: OrgInvitationParamSchema,
    response: OkSchema,
  },
  async (c) => {
    const { id, invitationId } = c.req.valid('param');
    await revokeOrgInvitation(serviceContext(c), session(c), id, invitationId);
    return c.json({ ok: true });
  },
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'delete',
    path: '/{id}/memberships/{membershipId}',
    summary: 'Revoke an organization membership',
    params: OrgMembershipParamSchema,
    response: OkSchema,
  },
  async (c) => {
    const { id, membershipId } = c.req.valid('param');
    await revokeOrgMembership(serviceContext(c), session(c), id, membershipId);
    return c.json({ ok: true });
  },
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'patch',
    path: '/{id}/memberships/{membershipId}',
    summary: "Change an organization member's roles",
    description:
      'Replaces the roles. The member keeps one active membership, but its id changes: personal API keys tied to the old membership stop working (keys of kind service, which no membership owns, keep working). Scheduled broadcasts of the member stay scheduled. Organization admin and Read only stand alone. The last org admin cannot lose the role (`LAST_ORG_ADMIN`).',
    params: OrgMembershipParamSchema,
    body: ChangeOrgMemberRolesSchema,
    response: OrgMemberSchema,
  },
  async (c) => {
    const { id, membershipId } = c.req.valid('param');
    return c.json(
      await changeOrgMemberRoles(
        serviceContext(c),
        session(c),
        id,
        membershipId,
        c.req.valid('json').roles,
      ),
    );
  },
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'post',
    path: '/{id}/invitations/{invitationId}/resend',
    summary: 'Resend an organization invitation',
    description:
      'Revokes the pending invitation and issues a new one for the same address and roles, with a fresh link and seven days, and mails it. The answer is the new invitation, with a new id. Counts against the hourly and daily invite limits.',
    params: OrgInvitationParamSchema,
    status: 201,
    response: OrgInvitationSchema,
  },
  async (c) => {
    const { id, invitationId } = c.req.valid('param');
    return c.json(await resendOrgInvitation(serviceContext(c), session(c), id, invitationId), 201);
  },
);

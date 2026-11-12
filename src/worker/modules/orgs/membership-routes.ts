import type { Context } from 'hono';
import {
  AcceptOrgInvitationSchema,
  IdParamSchema,
  InviteOrgMemberSchema,
  OkSchema,
  OrgInvitationListSchema,
  OrgInvitationParamSchema,
  OrgInvitationPreviewSchema,
  OrgInvitationSchema,
  OrgMemberListSchema,
  OrgMembershipListSchema,
  OrgMembershipParamSchema,
  OrgMembershipSchema,
} from '../../../shared/contracts/index.ts';
import { requireSession, type SessionAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestTheme } from '../../ssr/head.ts';
import { listMyOrgMemberships } from './access.ts';
import { invitationPage } from './invitation-page.ts';
import {
  acceptOrgInvitation,
  inviteOrgMember,
  listOrgInvitations,
  listOrgMembers,
  previewOrgInvitation,
  revokeOrgInvitation,
  revokeOrgMembership,
} from './membership-service.ts';

const session = (c: Context<AppBindings>): SessionAuth => {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return auth;
};

export const membershipRoutes = createRouter({ bodyLimit: false });

// The landing document is public; the accepting POST is always session and CSRF protected.
membershipRoutes.use('/invitations/accept', (c, next) =>
  c.req.method === 'GET' ? next() : requireSession(c, next),
);
membershipRoutes.use('/memberships/me', requireSession);
membershipRoutes.use('/:id/memberships', requireSession);
membershipRoutes.use('/:id/memberships/:membershipId', requireSession);
membershipRoutes.use('/:id/invitations', requireSession);
membershipRoutes.use('/:id/invitations/:invitationId', requireSession);

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
  async (c) =>
    c.json(await acceptOrgInvitation(serviceContext(c), session(c), c.req.valid('json').token)),
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
    response: OrgMembershipListSchema,
  },
  async (c) => c.json({ items: await listMyOrgMemberships(serviceContext(c), session(c).userId) }),
);
register(
  membershipRoutes,
  'organization memberships',
  {
    method: 'get',
    path: '/{id}/memberships',
    summary: 'List organization memberships',
    params: IdParamSchema,
    response: OrgMemberListSchema,
  },
  async (c) =>
    c.json({
      items: await listOrgMembers(serviceContext(c), session(c), c.req.valid('param').id),
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
    response: OrgInvitationListSchema,
  },
  async (c) =>
    c.json({
      items: await listOrgInvitations(serviceContext(c), session(c), c.req.valid('param').id),
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

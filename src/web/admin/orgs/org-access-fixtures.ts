import type { OrgInvitation, OrgMember } from '@/shared/contracts/org-membership.ts';
import {
  type FetchHandler,
  json,
  membershipFixture,
  type RenderAppOptions,
  renderApp as renderBaseApp,
} from '@/web/lib/test-utils.tsx';

export function renderMembers(options: RenderAppOptions = {}) {
  return renderBaseApp('/admin/o/o1/members', {
    memberships: [membershipFixture('o1')],
    selectedOrg: 'o1',
    session: 'admin',
    ...options,
  });
}

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: { accent: '#0f766e' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
};

export const member = (overrides: Partial<OrgMember> = {}): OrgMember => ({
  id: 'member-1',
  orgId: 'o1',
  orgName: 'Acme Gym',
  orgSlug: 'acme',
  personal: false,
  userId: 'user-ada',
  userName: 'Ada Lovelace',
  userEmail: 'ada@example.test',
  roles: ['template_author', 'pass_operator'],
  capabilities: ['org:read', 'templates:author', 'passes:operate'],
  createdAt: 1_700_000_000_000,
  revokedAt: null,
  ...overrides,
});

export const invitation = (overrides: Partial<OrgInvitation> = {}): OrgInvitation => ({
  id: 'invite-1',
  orgId: 'o1',
  email: 'pending@example.test',
  roles: ['read_only'],
  createdAt: 1_700_000_000_000,
  expiresAt: 4_000_000_000_000,
  revokedAt: null,
  acceptedAt: null,
  ...overrides,
});

export const handlers = (extra: Record<string, FetchHandler> = {}) => ({
  '/api/v1/orgs/o1': () => json(org),
  '/api/v1/orgs/o1/workspace': () => json(org),
  '/api/v1/wallet-providers/accounts': (url: URL) =>
    json({
      orgId: 'o1',
      mode: url.searchParams.get('mode'),
      provider: url.searchParams.get('provider'),
      accountId: null,
      revision: 0,
      state: 'absent',
      externalApprovalVerified: false,
      issuance: { state: 'disabled', reason: 'not_released' },
      updatedAt: null,
    }),
  '/api/v1/orgs/o1/memberships': () => json({ items: [], nextCursor: null }),
  '/api/v1/orgs/o1/invitations': () => json({ items: [], nextCursor: null }),
  '/api/v1/identities': () => json({ items: [], nextCursor: null }),
  '/api/v1/settings': () =>
    json({
      items: [],
      oidc: {
        issuer: 'https://id.plrs.im',
        platformAdminGroup: null,
        adminGroup: null,
        developerGroup: null,
        userGroup: null,
        consoleGroupRequired: false,
      },
      nextCursor: null,
    }),
  ...extra,
});

/** Members and invitations as the two list routes return them. */
export const lists = (members: OrgMember[], invitations: OrgInvitation[] = []) => ({
  '/api/v1/orgs/o1/memberships': () => json({ items: members, nextCursor: null }),
  '/api/v1/orgs/o1/invitations': () => json({ items: invitations, nextCursor: null }),
});

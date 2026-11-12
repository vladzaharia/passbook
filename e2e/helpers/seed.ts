import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { OrgMembership, OrgRole } from '../../src/shared/contracts/org-membership.ts';
import { strictEmail } from '../../src/shared/email.ts';
import { type Api, BASE, uid } from './api.ts';
import { nextOrgInvitationToken, snapshotMail } from './mail.ts';

const FILE = 'e2e/.auth/seed.json';

export interface Seed {
  org: { id: string; slug: string; name: string };
}

interface VerifiedIdentity {
  id: string;
  email: string;
  csrfToken: string;
}

/** Verify the session's exact primary address through the real platform-admin email API. */
async function verifiedIdentity(admin: Api, member: Api): Promise<VerifiedIdentity> {
  const session = await member.get<{
    authenticated: boolean;
    user?: { id: string; primaryEmail: string };
    csrfToken?: string;
  }>('/api/v1/session');
  const email = strictEmail(session.user?.primaryEmail);
  if (!session.authenticated || !session.user?.id || !session.csrfToken || !email) {
    throw new Error('A signed-in user with a valid primary email and CSRF token is required');
  }
  const path = `/api/v1/users/${encodeURIComponent(session.user.id)}`;
  let detail = await admin.get<{ emails: { email: string }[] }>(path);
  if (!detail.emails.some((entry) => entry.email === email)) {
    detail = await admin.send('POST', `${path}/emails`, { email });
  }
  if (!detail.emails.some((entry) => entry.email === email)) {
    throw new Error('The signed-in user has no verified matching email');
  }
  return { id: session.user.id, email, csrfToken: session.csrfToken };
}

async function inviteVerifiedMember(
  admin: Api,
  orgId: string,
  member: Api,
  identity: VerifiedIdentity,
  roles: OrgRole[],
): Promise<OrgMembership> {
  let memberships = await member.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me');
  let membership = memberships.items.find((item) => item.orgId === orgId);
  if (!membership) {
    const before = snapshotMail();
    await admin.send('POST', `/api/v1/orgs/${encodeURIComponent(orgId)}/invitations`, {
      email: identity.email,
      roles,
    });
    const sessionCookie = (await member.ctx.storageState()).cookies.find(
      (cookie) => cookie.name === '__Host-wallet_sid',
    );
    if (!sessionCookie) throw new Error('The signed-in user has no session cookie');
    const token = await nextOrgInvitationToken(before);
    // Native fetch avoids recording the secret request body in Playwright traces.
    const response = await fetch(`${BASE}/api/v1/orgs/invitations/accept`, {
      method: 'POST',
      headers: {
        Origin: BASE,
        Cookie: `${sessionCookie.name}=${sessionCookie.value}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': identity.csrfToken,
      },
      body: JSON.stringify({ token }),
    });
    // Do not include response bodies in errors: neither the token nor its link may be logged.
    if (!response.ok) {
      throw new Error(`Organization invitation acceptance failed (${response.status})`);
    }
    try {
      membership = (await response.json()) as OrgMembership;
    } catch {
      throw new Error('Organization invitation acceptance returned invalid JSON');
    }
    memberships = await member.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me');
  }
  const accepted = membership;
  const confirmed = memberships.items.find((item) => item.id === accepted.id);
  if (
    !confirmed ||
    [accepted, confirmed].some(
      (item) =>
        item.orgId !== orgId ||
        item.userId !== identity.id ||
        item.revokedAt !== null ||
        item.roles.length !== roles.length ||
        !roles.every((role) => item.roles.includes(role)),
    )
  ) {
    throw new Error('Organization membership is not active with the requested roles');
  }
  return accepted;
}

/** Invite an existing signed-in user and accept with that user's session and CSRF token. */
export async function addOrgMember(
  admin: Api,
  orgId: string,
  member: Api,
  roles: OrgRole[],
): Promise<OrgMembership> {
  return inviteVerifiedMember(admin, orgId, member, await verifiedIdentity(admin, member), roles);
}

/** Create an organization and give its signed-in creator an explicit tenant membership. */
export async function createOrgWithRoles(
  admin: Api,
  input: { slug: string; name: string },
  roles: OrgRole[] = ['org_admin'],
): Promise<Seed['org']> {
  const identity = await verifiedIdentity(admin, admin);
  const org = await admin.send<Seed['org']>('POST', '/api/v1/orgs', input);
  await inviteVerifiedMember(admin, org.id, admin, identity, roles);
  return { id: org.id, slug: org.slug, name: org.name };
}

/** One fresh org per run keeps specs independent of whatever the persisted local D1 already holds. */
export async function createSeed(api: Api): Promise<Seed> {
  // Listing templates syncs the baked ones (and Henry's org) into a fresh database.
  await api.get('/api/v1/templates');
  const slug = uid('e2e').toLowerCase();
  const org = await createOrgWithRoles(api, { slug, name: `E2E Org ${slug}` });
  const seed: Seed = { org: { id: org.id, slug, name: org.name } };
  mkdirSync('e2e/.auth', { recursive: true });
  writeFileSync(FILE, JSON.stringify(seed));
  return seed;
}

export const readSeed = (): Seed => JSON.parse(readFileSync(FILE, 'utf8')) as Seed;

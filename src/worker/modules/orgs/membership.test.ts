import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import {
  type OrgCapability,
  OrgCapabilitySchema,
  type OrgInvitation,
  OrgInvitationSchema,
  OrgMemberListSchema,
  type OrgMembership,
  OrgMembershipSchema,
  type OrgRole,
  OrgRoleSchema,
} from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess, requireOrgCapability } from './access.ts';

const fake = fakeAuth();
const clock = new ManualClock();
const mail: { to: string; text: string; html: string }[] = [];
let failMail = false;
let env: AppEnv;
const app = createApp({ stores: fake.stores, clock });
const admin = () => fake.admin();
const user = (id: string) => fake.user(id);
const call = (method: string, path: string, body?: unknown, headers = admin()) =>
  app.request(
    `/api/v1/orgs${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );

beforeAll(async () => {
  env = await makeEnv({
    PUBLIC_BASE_URL: 'https://wallet.test',
    EMAIL_FROM: 'passes@example.test',
    EMAIL: {
      send: async (message: { to: string; text: string; html: string }) => {
        if (failMail) throw new Error('mail down');
        mail.push(message);
        return { messageId: 'test-message' };
      },
    } as unknown as AppEnv['EMAIL'],
  });
  // Platform-admin bypass re-verifies a stored session, so fake sessions need real rows.
  fake.bindSessions(env.DB, clock);
});

async function setup() {
  await run(
    env.DB,
    "INSERT OR IGNORE INTO users (id, primary_email, created_at) VALUES ('admin-1', 'membership-platform-admin@example.test', ?)",
    [clock.now()],
  );
  const f = fixtures(env, clock);
  const org = await makeOrg(f);
  const person = await makeUser(f);
  return { f, org, person };
}

async function invite(
  orgId: string,
  email: string,
  roles: OrgRole[] = ['read_only'],
  headers = admin(),
) {
  const count = mail.length;
  const response = await call('POST', `/${orgId}/invitations`, { email, roles }, headers);
  expect(response.status).toBe(201);
  const body = await response.text();
  const invitation = JSON.parse(body) as OrgInvitation;
  expect(mail).toHaveLength(count + 1);
  const message = mail[count];
  expect(message?.to.toLowerCase()).toBe(email.trim().toLowerCase());
  const link = message?.text.match(
    /https:\/\/wallet\.test\/api\/v1\/orgs\/invitations\/accept#[^\s<>"']+/,
  )?.[0];
  expect(link).toBeTruthy();
  const token = new URL(link as string).hash.slice(1);
  expect(token).toBeTruthy();
  expect(body).not.toContain(token);
  OrgInvitationSchema.parse(invitation);
  expect(invitation).not.toHaveProperty('token');
  return { invitation, token };
}

async function accept(token: string, userId: string) {
  return call('POST', '/invitations/accept', { token }, user(userId));
}

async function join(
  orgId: string,
  person: { id: string; primaryEmail: string },
  roles: OrgRole[] = ['read_only'],
) {
  const issued = await invite(orgId, person.primaryEmail, roles);
  const response = await accept(issued.token, person.id);
  expect(response.status).toBe(200);
  const membership = OrgMembershipSchema.parse(await response.json());
  return { ...issued, membership };
}

describe('organization memberships', () => {
  it('does not infer membership from a platform role or pass ownership', async () => {
    const { f, org, person } = await setup();
    await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: f.ids.id(), orgId: org.id }).resolved,
      holderEmail: person.primaryEmail,
      ownerUserId: person.id,
    });
    const platform = fake.session({ userId: person.id, roles: ['admin', 'user'] });
    expect(await (await call('GET', '/memberships/me', undefined, platform)).json()).toEqual({
      items: [],
    });
    expect(await (await call('GET', '/memberships/me', undefined, user(person.id))).json()).toEqual(
      {
        items: [],
      },
    );
    expect((await call('GET', `/${org.id}/memberships`, undefined, user(person.id))).status).toBe(
      403,
    );
    expect((await call('GET', '', undefined, user(person.id))).status).toBe(403);
    expect(
      (await call('PATCH', `/${org.id}`, { name: 'Not allowed' }, user(person.id))).status,
    ).toBe(403);
    await invite(org.id, person.primaryEmail, ['read_only'], platform);
    expect(await (await call('GET', '/memberships/me', undefined, platform)).json()).toEqual({
      items: [],
    });
    expect((await call('GET', '/memberships/me', undefined, fake.apiKey())).status).toBe(401);
  });

  it('delivers a fragment-only secret, grants multiple roles and revokes on the next request', async () => {
    const { org, person } = await setup();
    const { invitation, token, membership } = await join(org.id, person, [
      'template_author',
      'pass_operator',
    ]);
    expect(membership).toMatchObject({
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
      userId: person.id,
      roles: ['template_author', 'pass_operator'],
      revokedAt: null,
    });
    expect(membership.capabilities).toEqual(
      expect.arrayContaining(['org:read', 'templates:author', 'passes:operate']),
    );
    expect(membership.capabilities).not.toContain('members:manage');
    const me = (await (
      await call('GET', '/memberships/me', undefined, user(person.id))
    ).json()) as {
      items: OrgMembership[];
    };
    expect(me.items).toContainEqual(membership);
    const members = (await (await call('GET', `/${org.id}/memberships`)).json()) as {
      items: OrgMembership[];
    };
    expect(members.items).toContainEqual(expect.objectContaining(membership));
    const invitations = await (await call('GET', `/${org.id}/invitations`)).text();
    expect(invitations).not.toContain(token);
    expect(invitations).not.toContain('token');
    expect((await accept(token, person.id)).status).not.toBe(200);
    const revoked = await call('DELETE', `/${org.id}/memberships/${membership.id}`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });
    const afterRevocation = (await (
      await call('GET', '/memberships/me', undefined, user(person.id))
    ).json()) as { items: OrgMembership[] };
    expect(afterRevocation.items).not.toContainEqual(membership);
    const audit = await all<{ detail: string | null }>(
      env.DB,
      'SELECT detail FROM audit_log WHERE org_id = ?',
      [org.id],
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(person.primaryEmail);
    expect(invitation.orgId).toBe(org.id);
  });

  it('refuses to revoke the last org admin, even for a platform admin, until another exists', async () => {
    const { f, org } = await setup();
    const sole = await join(org.id, await makeUser(f), ['org_admin']);
    const response = await call('DELETE', `/${org.id}/memberships/${sole.membership.id}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'LAST_ORG_ADMIN' });
    expect(
      (
        await all(env.DB, 'SELECT 1 FROM org_memberships WHERE id = ? AND revoked_at IS NULL', [
          sole.membership.id,
        ])
      ).length,
    ).toBe(1);
    const second = await join(org.id, await makeUser(f), ['org_admin']);
    expect((await call('DELETE', `/${org.id}/memberships/${sole.membership.id}`)).status).toBe(200);
    expect((await call('DELETE', `/${org.id}/memberships/${second.membership.id}`)).status).toBe(
      409,
    );
  });

  it('revokes an invitation whose email could not be sent and logs a stable code', async () => {
    const { f, org } = await setup();
    failMail = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const email = `undelivered-${f.ids.id()}@example.com`;
      const response = await call('POST', `/${org.id}/invitations`, {
        email,
        roles: ['read_only'],
      });
      expect(response.status).toBe(503);
      const rows = await all<{ revoked_at: number | null }>(
        env.DB,
        'SELECT revoked_at FROM org_invitations WHERE org_id = ?',
        [org.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
      const audit = await all<{ action: string }>(
        env.DB,
        'SELECT action FROM audit_log WHERE org_id = ? ORDER BY id',
        [org.id],
      );
      expect(audit.map((a) => a.action)).toEqual([
        'org_invitation.create',
        'org_invitation.revoke',
      ]);
      const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('INVITATION_SEND_FAILED');
      expect(logged).not.toContain('accept#');
    } finally {
      errors.mockRestore();
      failMail = false;
    }
  });

  it('lists only active memberships belonging to active users', async () => {
    const { f, org, person } = await setup();
    const revokedUser = await makeUser(f);
    const disabledUser = await makeUser(f);
    const active = await join(org.id, person);
    const revoked = await join(org.id, revokedUser);
    const disabled = await join(org.id, disabledUser);
    expect((await call('DELETE', `/${org.id}/memberships/${revoked.membership.id}`)).status).toBe(
      200,
    );
    await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [disabledUser.id]);
    const result = (await (await call('GET', `/${org.id}/memberships`)).json()) as {
      items: OrgMembership[];
    };
    expect(result.items).toContainEqual(expect.objectContaining(active.membership));
    expect(result.items.map((item) => item.id)).not.toContain(revoked.membership.id);
    expect(result.items.map((item) => item.id)).not.toContain(disabled.membership.id);
  });

  it('matches normalized verified email exactly, without plus or dot folding', async () => {
    const { f, org } = await setup();
    const exact = await makeUser(f, { primaryEmail: `first.last+${f.ids.id()}@example.com` });
    const unverified = await makeUser(f, {
      primaryEmail: `unverified-${f.ids.id()}@example.com`,
      verified: false,
    });
    const folded = await makeUser(f, {
      primaryEmail: exact.primaryEmail.replace('.', '').replace(/\+[^@]+/, ''),
    });
    const issued = await invite(org.id, exact.primaryEmail.toUpperCase());
    expect((await accept(issued.token, folded.id)).status).not.toBe(200);
    expect((await accept(issued.token, unverified.id)).status).not.toBe(200);
    expect((await accept(issued.token, exact.id)).status).toBe(200);
    const unverifiedInvite = await invite(org.id, unverified.primaryEmail);
    expect((await accept(unverifiedInvite.token, unverified.id)).status).not.toBe(200);
  });

  it('accepts a verified secondary address only for its owner', async () => {
    const { f, org, person } = await setup();
    const wrong = await makeUser(f);
    const secondary = `secondary-${f.ids.id()}@example.test`;
    await run(
      env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'magic_link', ?)",
      [secondary, person.id, clock.now()],
    );
    const issued = await invite(org.id, secondary);
    expect((await accept(issued.token, wrong.id)).status).not.toBe(200);
    const response = await accept(issued.token, person.id);
    expect(response.status).toBe(200);
    expect(OrgMembershipSchema.parse(await response.json()).userId).toBe(person.id);
  });

  it('allows exactly one concurrent acceptance and never reuses the consumed invitation', async () => {
    const { org, person } = await setup();
    const issued = await invite(org.id, person.primaryEmail);
    const responses = await Promise.all([
      accept(issued.token, person.id),
      accept(issued.token, person.id),
    ]);
    const successful = responses.filter((response) => response.status === 200);
    expect(successful).toHaveLength(1);
    const membership = OrgMembershipSchema.parse(await successful[0]?.json());
    expect((await call('DELETE', `/${org.id}/memberships/${membership.id}`)).status).toBe(200);
    expect((await accept(issued.token, person.id)).status).not.toBe(200);
    const rows = await all<{ id: string }>(
      env.DB,
      'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?',
      [org.id, person.id],
    );
    expect(rows).toEqual([{ id: membership.id }]);
  });

  it('lists members with name and email, and names the organization in the email and preview', async () => {
    const { f, org } = await setup();
    const person = await makeUser(f, { primaryEmail: 'named-member@example.test' });
    await run(env.DB, 'UPDATE users SET name = ? WHERE id = ?', ['Named Member', person.id]);
    const count = mail.length;
    const { token } = await join(org.id, person);
    expect(mail[count]?.text).toContain(`Join ${org.name} on PassBook`);
    expect(mail[count]?.html).toContain(org.name);
    const members = OrgMemberListSchema.parse(
      await (await call('GET', `/${org.id}/memberships`)).json(),
    );
    expect(members.items).toMatchObject([
      { userId: person.id, userName: 'Named Member', userEmail: 'named-member@example.test' },
    ]);
    const mine = await call('POST', '/invitations/preview', { token }, {});
    expect(mine.status).toBe(400);
    const fresh = await invite(org.id, 'someone-else@example.test');
    const preview = await call('POST', '/invitations/preview', { token: fresh.token }, {});
    expect(await preview.json()).toEqual({ orgName: org.name });
    expect((await call('POST', '/invitations/preview', { token: 'x'.repeat(43) }, {})).status).toBe(
      400,
    );
  });

  it('serves a private public landing page and requires CSRF on acceptance', async () => {
    const { org, person } = await setup();
    const issued = await invite(org.id, person.primaryEmail);
    const page = await call('GET', '/invitations/accept', undefined, {});
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = user(person.id);
    expect(
      (await call('POST', '/invitations/accept', { token: issued.token }, withoutCsrf)).status,
    ).toBe(403);
    expect((await accept(issued.token, person.id)).status).toBe(200);
  });

  it('rejects expired, revoked, and already consumed invitations', async () => {
    const { f, org, person } = await setup();
    const expired = await invite(org.id, person.primaryEmail);
    clock.advance(7 * 24 * 60 * 60 * 1000);
    expect((await accept(expired.token, person.id)).status).not.toBe(200);
    const revoked = await invite(org.id, person.primaryEmail);
    const deletion = await call('DELETE', `/${org.id}/invitations/${revoked.invitation.id}`);
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toEqual({ ok: true });
    expect((await accept(revoked.token, person.id)).status).not.toBe(200);
    await expect(
      run(env.DB, 'UPDATE org_invitations SET revoked_at = NULL WHERE id = ?', [
        revoked.invitation.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'DELETE FROM org_invitations WHERE id = ?', [revoked.invitation.id]),
    ).rejects.toThrow();
    const other = await makeUser(f);
    const used = await invite(org.id, other.primaryEmail);
    expect((await accept(used.token, other.id)).status).toBe(200);
    expect((await accept(used.token, other.id)).status).not.toBe(200);
  });

  it('isolates organizations and rejects inactive organizations and users', async () => {
    const { f, org, person } = await setup();
    const otherOrg = await makeOrg(f);
    const joined = await join(org.id, person, ['org_admin']);
    expect(
      (await call('GET', `/${otherOrg.id}/memberships`, undefined, user(person.id))).status,
    ).toBe(403);
    expect(
      (await call('DELETE', `/${otherOrg.id}/memberships/${joined.membership.id}`)).status,
    ).not.toBe(200);
    const pending = await invite(org.id, `pending-${f.ids.id()}@example.com`);
    expect(
      (await call('DELETE', `/${otherOrg.id}/invitations/${pending.invitation.id}`)).status,
    ).not.toBe(200);
    expect((await call('GET', '', undefined, user(person.id))).status).toBe(403);
    // org:manage lets an org_admin edit its own org (docs/api.md); isolation and lifecycle stay closed.
    expect((await call('PATCH', `/${otherOrg.id}`, { name: 'No' }, user(person.id))).status).toBe(
      403,
    );
    expect(
      (await call('PATCH', `/${org.id}`, { status: 'suspended' }, user(person.id))).status,
    ).toBe(403);
    const disabled = await makeUser(f);
    const disabledInvite = await invite(org.id, disabled.primaryEmail);
    await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [disabled.id]);
    expect((await accept(disabledInvite.token, disabled.id)).status).not.toBe(200);
    const suspended = await makeUser(f);
    const suspendedInvite = await invite(org.id, suspended.primaryEmail);
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect((await accept(suspendedInvite.token, suspended.id)).status).not.toBe(200);
    const me = (await (
      await call('GET', '/memberships/me', undefined, user(person.id))
    ).json()) as {
      items: OrgMembership[];
    };
    expect(me.items.some((item) => item.orgId === org.id)).toBe(false);
  });

  it('rejects arbitrary roles and capability injection', async () => {
    const { org, person } = await setup();
    for (const body of [
      { email: person.primaryEmail, roles: ['admin'] },
      { email: person.primaryEmail, roles: ['members:manage'] },
      { email: person.primaryEmail, roles: [] },
      { email: person.primaryEmail, roles: ['read_only'], capabilities: ['members:manage'] },
    ]) {
      expect((await call('POST', `/${org.id}/invitations`, body)).status).toBe(422);
    }
  });

  it('limits member management to organization administrators and removes it after revocation', async () => {
    const { f, org } = await setup();
    const manager = await makeUser(f);
    const reader = await makeUser(f);
    const managed = await join(org.id, manager, ['org_admin']);
    await join(org.id, await makeUser(f), ['org_admin']);
    await join(org.id, reader);
    expect((await call('GET', `/${org.id}/invitations`, undefined, user(reader.id))).status).toBe(
      403,
    );
    expect(
      (
        await call(
          'POST',
          `/${org.id}/invitations`,
          { email: `blocked-${f.ids.id()}@example.com`, roles: ['read_only'] },
          user(reader.id),
        )
      ).status,
    ).toBe(403);
    const pending = await invite(
      org.id,
      `managed-${f.ids.id()}@example.com`,
      ['read_only'],
      user(manager.id),
    );
    expect((await call('GET', `/${org.id}/memberships`, undefined, user(manager.id))).status).toBe(
      200,
    );
    expect((await call('DELETE', `/${org.id}/memberships/${managed.membership.id}`)).status).toBe(
      200,
    );
    expect((await call('GET', `/${org.id}/memberships`, undefined, user(manager.id))).status).toBe(
      403,
    );
    expect((await call('GET', `/${org.id}/invitations`, undefined, user(manager.id))).status).toBe(
      403,
    );
    expect(
      (
        await call(
          'DELETE',
          `/${org.id}/invitations/${pending.invitation.id}`,
          undefined,
          user(manager.id),
        )
      ).status,
    ).toBe(403);
  });

  it('enforces the fixed capability matrix, including invalid capabilities and immediate revocation', async () => {
    const { f, org } = await setup();
    const ctx = createServiceContext(env, { clock });
    const grants: Record<OrgRole, OrgCapability[]> = {
      org_admin: [...OrgCapabilitySchema.options],
      integration_admin: ['org:read', 'integrations:read', 'integrations:manage', 'templates:read'],
      template_author: ['org:read', 'templates:read', 'templates:author'],
      template_reviewer: ['org:read', 'templates:read', 'templates:review'],
      template_publisher: ['org:read', 'templates:read', 'templates:publish'],
      pass_operator: [
        'org:read',
        'templates:read',
        'passes:read',
        'passes:operate',
        'messages:read',
        'messages:manage',
        'scanning:read',
        'audit:read',
      ],
      read_only: [
        'org:read',
        'integrations:read',
        'templates:read',
        'passes:read',
        'messages:read',
        'scanning:read',
        'audit:read',
      ],
    };
    await join(org.id, await makeUser(f), ['org_admin']);
    for (const role of OrgRoleSchema.options) {
      const person = await makeUser(f);
      const { membership } = await join(org.id, person, [role]);
      expect(new Set(membership.capabilities)).toEqual(new Set(grants[role]));
      for (const capability of OrgCapabilitySchema.options) {
        const check = requireOrgCapability(ctx, person.id, org.id, capability);
        if (grants[role].includes(capability))
          await expect(check).resolves.toMatchObject({ id: membership.id });
        else await expect(check).rejects.toBeDefined();
      }
      await expect(
        requireOrgCapability(ctx, person.id, org.id, 'anything' as OrgCapability),
      ).rejects.toBeDefined();
      expect((await call('DELETE', `/${org.id}/memberships/${membership.id}`)).status).toBe(200);
      expect(await getOrgAccess(ctx, person.id, org.id)).toBeNull();
      await expect(requireOrgCapability(ctx, person.id, org.id, 'org:read')).rejects.toBeDefined();
    }
  });

  it('stores only a token hash and makes role assignments immutable', async () => {
    const { org, person } = await setup();
    const { invitation, token, membership } = await join(org.id, person, ['read_only']);
    const stored = await all<Record<string, unknown>>(
      env.DB,
      'SELECT * FROM org_invitations WHERE id = ?',
      [invitation.id],
    );
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
    await expect(
      run(env.DB, 'UPDATE org_invitations SET roles = ? WHERE id = ?', [
        '["org_admin"]',
        invitation.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'UPDATE org_memberships SET roles = ? WHERE id = ?', [
        '["org_admin"]',
        membership.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'DELETE FROM org_memberships WHERE id = ?', [membership.id]),
    ).rejects.toThrow();
    expect(
      (await getOrgAccess(createServiceContext(env, { clock }), person.id, org.id))?.roles,
    ).toEqual(['read_only']);
  });
});

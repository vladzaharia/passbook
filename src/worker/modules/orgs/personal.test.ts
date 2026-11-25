import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { Logger } from '../../platform/log.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { signInOidc } from '../auth/oidc-sign-in.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { listMyOrgMemberships, membershipDto } from './access.ts';
import { ensurePersonalOrg } from './personal.ts';
import { type MembershipRow, myMemberships } from './repo-members.ts';

const clock = new ManualClock();
const app = createApp({
  stores: (e) => ({ ...denyAllStores, sessions: createSessionStore(e, clock) }),
  clock,
});
let appEnv: AppEnv;
let f: Fixtures;
let admin: SessionFixture;
const errors: { event: string; data?: Record<string, unknown> }[] = [];
const log: Logger = {
  debug() {},
  info() {},
  warn() {},
  error: (event, data) => void errors.push({ event, data }),
  child: () => log,
};
const ctx = () => createServiceContext(appEnv, { clock, log });

beforeAll(async () => {
  appEnv = await makeEnv();
  f = fixtures(appEnv, clock);
  admin = await makeSession(f, { userId: (await makeUser(f)).id, roles: ['admin', 'user'] });
});

/** A user with a live admin session, named as given. */
async function adminUser(name: string | null) {
  const user = await makeUser(f);
  await run(appEnv.DB, 'UPDATE users SET name = ? WHERE id = ?', [name, user.id]);
  const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
  return { userId: user.id, sessionId: await sha256Hex(session.cookieValue) };
}
const orgsOf = (userId: string) =>
  all<{ id: string; name: string; slug: string; status: string }>(
    appEnv.DB,
    'SELECT id, name, slug, status FROM orgs WHERE personal_user_id = ?',
    [userId],
  );

describe('ensurePersonalOrg', () => {
  it('creates the org, entitlements, accepted invitation, org_admin membership and audit row', async () => {
    const who = await adminUser('Ada Lovelace');
    await ensurePersonalOrg(ctx(), who);
    const [org] = await orgsOf(who.userId);
    expect(org).toMatchObject({ name: 'Ada Lovelace', slug: 'personal-ada-lovelace' });
    const db = appEnv.DB;
    expect(
      await first(db, 'SELECT preset FROM org_entitlements WHERE org_id = ?', [org?.id]),
    ).toMatchObject({ preset: 'legacy' });
    const member = await first<{ roles: string; invitation_id: string }>(
      db,
      'SELECT roles, invitation_id FROM org_memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL',
      [org?.id, who.userId],
    );
    expect(member?.roles).toBe('["org_admin"]');
    expect(
      await first(
        db,
        'SELECT accepted_at FROM org_invitations WHERE id = ? AND accepted_at IS NOT NULL',
        [member?.invitation_id],
      ),
    ).not.toBeNull();
    const audit = await first<{ actor_id: string; actor_type: string }>(
      db,
      "SELECT actor_id, actor_type FROM audit_log WHERE action = 'org.create' AND org_id = ?",
      [org?.id],
    );
    expect(audit).toEqual({ actor_id: who.userId, actor_type: 'user' });
    expect(await first(db, 'SELECT 1 AS x FROM authority_grants')).toBeNull();
  });

  it('is a no-op the second time, and concurrent ensures yield one org', async () => {
    const who = await adminUser('Grace Hopper');
    await Promise.all([
      ensurePersonalOrg(ctx(), who),
      ensurePersonalOrg(ctx(), who),
      ensurePersonalOrg(ctx(), who),
    ]);
    await ensurePersonalOrg(ctx(), who);
    expect(await orgsOf(who.userId)).toHaveLength(1);
    expect(
      (await all(appEnv.DB, 'SELECT id FROM org_memberships WHERE user_id = ?', [who.userId]))
        .length,
    ).toBe(1);
  });

  it('does not recreate a closed personal org', async () => {
    const who = await adminUser('Closed Person');
    await ensurePersonalOrg(ctx(), who);
    await run(appEnv.DB, "UPDATE orgs SET status = 'deleted' WHERE personal_user_id = ?", [
      who.userId,
    ]);
    await ensurePersonalOrg(ctx(), who);
    expect(await orgsOf(who.userId)).toHaveLength(1);
  });

  it('suffixes the slug on a collision', async () => {
    const a = await adminUser('Sam Twin');
    const b = await adminUser('Sam Twin');
    await ensurePersonalOrg(ctx(), a);
    await ensurePersonalOrg(ctx(), b);
    expect((await orgsOf(a.userId))[0]?.slug).toBe('personal-sam-twin');
    expect((await orgsOf(b.userId))[0]?.slug).toBe('personal-sam-twin-2');
  });

  it('still finds a slug when every numbered one is taken by other users', async () => {
    const who = await adminUser('Crowded Name');
    for (const slug of [
      'personal-crowded-name',
      ...[2, 3, 4, 5, 6, 7].map((n) => `personal-crowded-name-${n}`),
    ]) {
      const id = f.ids.id();
      await run(
        appEnv.DB,
        'INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
        [id, slug, slug],
      );
    }
    await ensurePersonalOrg(ctx(), who);
    const [org] = await orgsOf(who.userId);
    expect(org?.slug).toBe(`personal-crowded-name-${who.userId.slice(-12)}`);
  });

  it('falls back to the email local part, then to the id prefix', async () => {
    const noName = await adminUser(null);
    await ensurePersonalOrg(ctx(), noName);
    const email =
      (
        await first<{ primary_email: string }>(
          appEnv.DB,
          'SELECT primary_email FROM users WHERE id = ?',
          [noName.userId],
        )
      )?.primary_email ?? '';
    expect((await orgsOf(noName.userId))[0]?.name).toBe(email.split('@')[0]);
    const placeholder = await adminUser(null);
    await run(appEnv.DB, 'UPDATE users SET primary_email = ? WHERE id = ?', [
      `ghost-${placeholder.userId}@unverified.invalid`,
      placeholder.userId,
    ]);
    await ensurePersonalOrg(ctx(), placeholder);
    expect((await orgsOf(placeholder.userId))[0]?.name).toBe(
      `User ${placeholder.userId.slice(0, 8)}`,
    );
  });

  it('logs a stable code and throws nothing when the write fails', async () => {
    const who = await adminUser('Fails Here');
    await run(
      appEnv.DB,
      "CREATE TRIGGER personal_boom BEFORE INSERT ON org_entitlements BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      errors.length = 0;
      await expect(ensurePersonalOrg(ctx(), who)).resolves.toBeUndefined();
    } finally {
      await run(appEnv.DB, 'DROP TRIGGER personal_boom');
    }
    expect(errors).toEqual([
      {
        event: 'org.personal_ensure_failed',
        data: { code: 'PERSONAL_ORG_ENSURE_FAILED', kind: 'other' },
      },
    ]);
    expect(await orgsOf(who.userId)).toHaveLength(0);
  });

  it('never creates an org for a session without the admin role', async () => {
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id, roles: ['user'] });
    errors.length = 0;
    await ensurePersonalOrg(ctx(), {
      userId: user.id,
      sessionId: await sha256Hex(session.cookieValue),
    });
    expect(await orgsOf(user.id)).toHaveLength(0);
    expect(errors[0]?.event).toBe('org.personal_ensure_failed');
  });
});

let subjects = 0;
/** A user with a linked Pocket ID identity in `groups`, and a sign-in for them. */
async function oidcUser(groups: string[], logger: Logger = log) {
  const user = await makeUser(f);
  const sub = `sub-personal-${++subjects}`;
  await run(
    appEnv.DB,
    `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at)
     VALUES ('pocketid', ?, ?, ?, 1, '[]', 1)`,
    [sub, user.id, user.primaryEmail],
  );
  return {
    userId: user.id,
    signIn: () =>
      signInOidc(
        createServiceContext(appEnv, { clock, log: logger }),
        { sub, email: user.primaryEmail, emailVerified: true, name: 'Pat Example', groups },
        { ipPrefix: null, userAgent: null },
      ),
  };
}

describe('sign-in', () => {
  it('creates the org for an admin and nothing for a plain user', async () => {
    const adminSignIn = await oidcUser(['wallet_admins']);
    await adminSignIn.signIn();
    expect(await orgsOf(adminSignIn.userId)).toHaveLength(1);
    await adminSignIn.signIn();
    expect(await orgsOf(adminSignIn.userId)).toHaveLength(1);
    const plain = await oidcUser(['wallet_users']);
    await plain.signIn();
    expect(await orgsOf(plain.userId)).toHaveLength(0);
  });

  it('still succeeds, and logs the code, when the personal org cannot be written', async () => {
    const who = await oidcUser(['wallet_admins']);
    await run(
      appEnv.DB,
      "CREATE TRIGGER personal_boom2 BEFORE INSERT ON org_entitlements BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    errors.length = 0;
    try {
      const result = await who.signIn();
      expect(result.session.cookieValue).toBeTruthy();
    } finally {
      await run(appEnv.DB, 'DROP TRIGGER personal_boom2');
    }
    expect(errors.map((e) => e.data?.code)).toContain('PERSONAL_ORG_ENSURE_FAILED');
  });
});

describe('membership list', () => {
  it('labels the owner their own org "Personal" and shows anyone else the stored name', async () => {
    const owner = await adminUser('Maya Chen');
    await ensurePersonalOrg(ctx(), owner);
    const own = await listMyOrgMemberships(ctx(), owner.userId);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      orgName: 'Personal',
      orgSlug: 'personal-maya-chen',
      personal: true,
    });
    // Anyone else who is shown the membership sees the stored name.
    const [row] = await myMemberships(appEnv.DB, owner.userId);
    const other = [membershipDto(row as MembershipRow)];
    expect(other[0]).toMatchObject({ orgName: 'Maya Chen', personal: true });
  });
});

describe('guard rails', () => {
  const call = (method: string, path: string, body?: unknown) =>
    app.request(
      `/api/v1/orgs${path}`,
      {
        method,
        headers: { ...admin.headers, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
      appEnv,
    );

  it('refuses a manual slug in the personal- namespace, on create and on rename', async () => {
    const refused = await call('POST', '', { slug: 'personal-squat', name: 'Squat' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('ORG_SLUG_RESERVED');
    const ok = await call('POST', '', { slug: 'regular-org', name: 'Regular', addMe: false });
    const { id } = (await ok.json()) as { id: string };
    const rename = await call('PATCH', `/${id}`, { slug: 'personal-regular' });
    expect(rename.status).toBe(403);
    expect(
      await first(appEnv.DB, "SELECT id FROM orgs WHERE slug = 'personal-regular'"),
    ).toBeNull();
  });

  it('keeps the marker fixed while allowing a rename', async () => {
    const owner = await adminUser('Rename Me');
    await ensurePersonalOrg(ctx(), owner);
    const [org] = await orgsOf(owner.userId);
    await run(appEnv.DB, "UPDATE orgs SET name = 'Renamed' WHERE id = ?", [org?.id]);
    await expect(
      run(appEnv.DB, 'UPDATE orgs SET personal_user_id = NULL WHERE id = ?', [org?.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(appEnv.DB, 'UPDATE orgs SET personal_user_id = ? WHERE id = ?', [admin.userId, org?.id]),
    ).rejects.toThrow(/immutable/);
    expect((await orgsOf(owner.userId))[0]?.name).toBe('Renamed');
  });

  it('shows the personal flag and owner to the owner only; another platform admin is refused', async () => {
    const owner = await adminUser('Visible Owner');
    await ensurePersonalOrg(ctx(), owner);
    const [org] = await orgsOf(owner.userId);
    const refused = await call('GET', `/${org?.id}`);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('ORG_PERSONAL');
    const session = await makeSession(f, { userId: owner.userId, roles: ['admin', 'user'] });
    const res = await app.request(`/api/v1/orgs/${org?.id}`, { headers: session.headers }, appEnv);
    expect(await res.json()).toMatchObject({
      personal: true,
      personalOwner: { id: owner.userId, name: 'Visible Owner' },
    });
  });
});

describe('one member, forever', () => {
  async function ownerWithOrg() {
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
    const who = { userId: user.id, sessionId: await sha256Hex(session.cookieValue) };
    await ensurePersonalOrg(ctx(), who);
    const [org] = await orgsOf(user.id);
    return { user, session, org: org as { id: string } };
  }
  const send = (session: SessionFixture, method: string, path: string, body?: unknown) =>
    app.request(
      `/api/v1/orgs${path}`,
      {
        method,
        headers: { ...session.headers, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
      appEnv,
    );

  it('blocks a second member and any other invitation in SQL, and allows an ordinary org', async () => {
    const { org } = await ownerWithOrg();
    const guest = await makeUser(f);
    const insertInvitation = (id: string, orgId: string, email: string, accepted: number | null) =>
      run(
        appEnv.DB,
        `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
         VALUES (?, ?, ?, '["read_only"]', ?, 1, 2, ?)`,
        [id, orgId, email, `${id}-hash`, accepted],
      );
    await expect(insertInvitation('open-1', org.id, 'x@example.com', null)).rejects.toThrow(
      /one member/,
    );
    await expect(insertInvitation('acc-1', org.id, guest.primaryEmail, 1)).rejects.toThrow(
      /one member/,
    );
    const direct = f.ids.id();
    await expect(
      run(
        appEnv.DB,
        'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, \'["read_only"]\', 1)',
        [f.ids.id(), org.id, guest.id, direct],
      ),
    ).rejects.toThrow();
    // An ordinary org is unaffected.
    const ordinary = f.ids.id();
    await run(
      appEnv.DB,
      'INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
      [ordinary, `ord-${ordinary.slice(-6)}`, 'Ordinary'],
    );
    await insertInvitation('ord-1', ordinary, 'x@example.com', null);
    await run(
      appEnv.DB,
      "INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, 'ord-1', '[\"read_only\"]', 1)",
      [f.ids.id(), ordinary, guest.id],
    );
  });

  it('refuses invitations through the API with a stable code, and refuses revoking the owner', async () => {
    const { session, org, user } = await ownerWithOrg();
    const invite = await send(session, 'POST', `/${org.id}/invitations`, {
      email: 'new@example.com',
      roles: ['read_only'],
    });
    expect(invite.status).toBe(409);
    expect(((await invite.json()) as { code: string }).code).toBe('ORG_PERSONAL_SINGLE_MEMBER');
    const member = await first<{ id: string }>(
      appEnv.DB,
      'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?',
      [org.id, user.id],
    );
    const revoke = await send(session, 'DELETE', `/${org.id}/memberships/${member?.id}`);
    expect(revoke.status).toBe(409);
    expect(((await revoke.json()) as { code: string }).code).toBe('ORG_PERSONAL_SINGLE_MEMBER');
    expect(
      await first(appEnv.DB, 'SELECT 1 FROM org_memberships WHERE id = ? AND revoked_at IS NULL', [
        member?.id,
      ]),
    ).not.toBeNull();
  });
});

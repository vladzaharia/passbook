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
import { listMyOrgMemberships } from './access.ts';
import { ensurePersonalOrg } from './personal.ts';

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
    ).toMatchObject({ preset: 'standard' });
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
    const adminSignIn = await oidcUser(['wallet-admins']);
    await adminSignIn.signIn();
    expect(await orgsOf(adminSignIn.userId)).toHaveLength(1);
    await adminSignIn.signIn();
    expect(await orgsOf(adminSignIn.userId)).toHaveLength(1);
    const plain = await oidcUser(['wallet-users']);
    await plain.signIn();
    expect(await orgsOf(plain.userId)).toHaveLength(0);
  });

  it('still succeeds, and logs the code, when the personal org cannot be written', async () => {
    const who = await oidcUser(['wallet-admins']);
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
    const [org] = await orgsOf(owner.userId);
    const own = await listMyOrgMemberships(ctx(), owner.userId);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      orgName: 'Personal',
      orgSlug: 'personal-maya-chen',
      personal: true,
    });
    const guest = await makeUser(f);
    const invitation = f.ids.id();
    await run(
      appEnv.DB,
      "INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at) VALUES (?, ?, 'g@example.com', '[\"read_only\"]', ?, 1, 2, 1)",
      [invitation, org?.id, f.ids.token()],
    );
    await run(
      appEnv.DB,
      'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, \'["read_only"]\', 1)',
      [f.ids.id(), org?.id, guest.id, invitation],
    );
    const other = await listMyOrgMemberships(ctx(), guest.id);
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
    const ok = await call('POST', '', { slug: 'regular-org', name: 'Regular' });
    const { id } = (await ok.json()) as { id: string };
    const rename = await call('PATCH', `/${id}`, { slug: 'personal-regular' });
    expect([400, 403]).toContain(rename.status);
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

  it('lets platform admins see the personal flag and owner in the directory', async () => {
    const owner = await adminUser('Visible Owner');
    await ensurePersonalOrg(ctx(), owner);
    const [org] = await orgsOf(owner.userId);
    const res = await call('GET', `/${org?.id}`);
    expect(await res.json()).toMatchObject({
      personal: true,
      personalOwner: { id: owner.userId, name: 'Visible Owner' },
    });
  });
});

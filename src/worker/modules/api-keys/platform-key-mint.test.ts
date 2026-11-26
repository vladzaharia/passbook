import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { PLATFORM_KEY_SCOPES } from '../../../shared/contracts/api-keys.ts';
import { grant } from '../../platform/authority.ts';
import { refusal } from '../../platform/authority-ext-fixtures.ts';
import { setupGrant } from '../../platform/authority-test-fixtures.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { endAdminAccess } from '../auth/repo-sessions.ts';
import { assertPlatformKey } from './platform-key.ts';
import { auditPlatformKeyRefusal } from './refusal-audit.ts';
import { createApiKeyStore } from './service.ts';
import {
  type CreatedKey,
  create,
  f,
  h,
  keyBody,
  member,
  org,
  platformSession,
  setup,
  teardown,
} from './test-kit.ts';

beforeEach(setup);
afterEach(teardown);

const DAY = 86_400_000;
const keyRows = async () => (await all(h.env.DB, 'SELECT id FROM api_keys')).length;
const oidc = { kind: 'platform', userId: 'u', sessionId: 's', amr: 'oidc' } as const;
const breakGlass = { ...oidc, amr: 'breakglass' } as const;
const platformBody = (scopes: string[], days = 30) => ({
  name: 'Ops',
  orgId: null,
  scopes,
  expiresAt: h.clock.now() + days * DAY,
  ipAllow: ['198.51.100.0/24'],
});

describe('which platform scopes can be minted', () => {
  it('is none until a route accepts one: the request fails validation, for a platform admin too', async () => {
    const session = await platformSession();
    const before = await keyRows();
    for (const scope of PLATFORM_KEY_SCOPES)
      expect((await create(session.headers, platformBody([scope]))).status, scope).toBe(422);
    expect(await keyRows()).toBe(before);
  });

  it('is refused to a member and to an organization key, as before', async () => {
    const before = await keyRows();
    const admin = await member('org_admin');
    expect(
      (await create(admin.session.headers, { ...keyBody(org.id), scopes: ['platform:read'] }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    const parent = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['api-keys:write', 'passes:read'],
    });
    for (const body of [
      { ...keyBody(org.id), scopes: ['platform:read'] },
      platformBody(['platform:read']),
    ])
      expect((await create(parent.headers, body)).status).toBeGreaterThanOrEqual(400);
    // Only the parent was made.
    expect(await keyRows()).toBe(before + 1);
  });
});

describe('the rules a Platform key is minted under', () => {
  const rules =
    (
      authority: Parameters<typeof assertPlatformKey>[0],
      kind: 'platform' | 'service',
      mode: 'live' | 'test',
      held: string[],
      days: number,
    ) =>
    () =>
      assertPlatformKey(authority, kind, mode, held, h.clock.now() + days * DAY, h.clock.now());
  const refusedWith = (fn: () => void, code: string) =>
    expect(fn).toThrow(expect.objectContaining({ code }));

  it('is a platform key only, holding platform scopes alone, Live only', () => {
    expect(rules(oidc, 'platform', 'live', ['platform:users'], 30)).not.toThrow();
    refusedWith(
      rules(oidc, 'service', 'live', ['platform:users'], 30),
      'API_KEY_PLATFORM_SCOPE_KIND',
    );
    refusedWith(
      rules(oidc, 'platform', 'live', ['platform:users', 'passes:read'], 30),
      'API_KEY_PLATFORM_SCOPES_ALONE',
    );
    refusedWith(rules(oidc, 'platform', 'test', ['platform:read'], 30), 'API_KEY_PLATFORM_LIVE');
  });

  it('is made in a Polaris ID session: break-glass is refused', () => {
    refusedWith(
      rules(breakGlass, 'platform', 'live', ['platform:read'], 30),
      'IDP_SIGN_IN_REQUIRED',
    );
  });

  it('lives at most 30 days with a write scope, and 90 with platform:read alone', () => {
    expect(rules(oidc, 'platform', 'live', ['platform:users'], 30)).not.toThrow();
    refusedWith(rules(oidc, 'platform', 'live', ['platform:users'], 32), 'API_KEY_EXPIRY_TOO_LONG');
    refusedWith(
      rules(oidc, 'platform', 'live', ['platform:read', 'platform:users'], 60),
      'API_KEY_EXPIRY_TOO_LONG',
    );
    expect(rules(oidc, 'platform', 'live', ['platform:read'], 90)).not.toThrow();
  });

  it('ignores a key with no platform scope', () => {
    expect(rules(breakGlass, 'service', 'test', ['passes:read'], 400)).not.toThrow();
  });
});

describe('a Platform key is rotated by a Polaris ID session only', () => {
  it('refuses break-glass, and a key holds no api-keys scope to rotate or mint one', async () => {
    const session = await platformSession();
    const key = await makeApiKey(f(), {
      orgId: null,
      kind: 'platform',
      scopes: ['platform:users'],
      expiresAt: h.clock.now() + 30 * DAY,
      ipAllow: ['198.51.100.0/24'],
    });
    const user = await makeUser(f());
    const bg = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      amr: 'breakglass',
    });
    const rotate = (headers: Record<string, string>) =>
      h.call(`/api/v1/api-keys/${key.id}/rotate`, {
        method: 'POST',
        headers,
        json: { orgId: null, overlapHours: 1 },
      });
    await expectProblem(await rotate(bg.headers), 403, 'IDP_SIGN_IN_REQUIRED');
    const rotated = await rotate(session.headers);
    expect(rotated.status).toBe(201);
    const next = (await rotated.json()) as { key: CreatedKey };
    // The successor is the rotator's, at the rotator's revision.
    const row = await first<{ created_by: string; creator_access_revision: number }>(
      h.env.DB,
      'SELECT created_by, creator_access_revision FROM api_keys WHERE id = ?',
      [next.key.id],
    );
    expect(row?.creator_access_revision).toBe(
      (
        await first<{ r: number }>(
          h.env.DB,
          'SELECT access_revision AS r FROM users WHERE id = ?',
          [row?.created_by ?? ''],
        )
      )?.r,
    );
    const headers = { ...key.headers, 'cf-connecting-ip': '198.51.100.7' };
    await expectProblem(
      await create(headers, platformBody(['platform:read'])),
      403,
      'MISSING_SCOPE',
    );
    await expectProblem(await rotate(headers), 403, 'MISSING_SCOPE');
  });
});

describe('the row refuses what the mint refuses', () => {
  const insert = (
    kind: string,
    orgId: string | null,
    scopes: string[],
    row: { mode?: string; createdBy?: string | null; amr?: string | null; days?: number } = {},
  ) =>
    run(
      h.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, expires_at, ip_allow, created_by, created_amr)
       VALUES (?, ?, 'forged', ?, ?, ?, ?, 1, ?, ?, '["198.51.100.0/24"]', ?, ?)`,
      [
        crypto.randomUUID(),
        orgId,
        crypto.randomUUID().slice(0, 8),
        crypto.randomUUID(),
        JSON.stringify(scopes),
        row.mode ?? 'live',
        kind,
        1 + (row.days ?? 30) * DAY,
        row.createdBy === undefined ? 'someone' : row.createdBy,
        row.amr === undefined ? 'oidc' : row.amr,
      ],
    );
  beforeEach(async () => {
    await run(
      h.env.DB,
      "INSERT OR IGNORE INTO users (id, primary_email, created_at) VALUES ('someone', 'someone@x.test', 1)",
    );
  });

  it('aborts a platform scope on a service key, or on a platform key that names an org', async () => {
    await expect(insert('service', org.id, ['platform:users'])).rejects.toThrow(
      /platform scope on a non-platform key/,
    );
    await withoutTrigger(h.env.DB, 'api_keys_kind_rules', () =>
      expect(insert('platform', org.id, ['platform:users'])).rejects.toThrow(
        /platform scope on a non-platform key/,
      ),
    );
  });

  it('aborts platform and organization scopes on one row, and takes the two flavours apart', async () => {
    await expect(insert('platform', null, ['platform:users', 'passes:read'])).rejects.toThrow(
      /platform and org scopes together/,
    );
    await expect(insert('platform', null, ['platform:users'])).resolves.toBeDefined();
    await expect(insert('platform', null, ['passes:read'], { amr: null })).resolves.toBeDefined();
    await expect(insert('service', org.id, ['passes:read'])).resolves.toBeDefined();
  });

  it('aborts a Platform key that is not Live, has no creator, was not made in a Polaris ID session, or lives too long', async () => {
    const broken = /platform key breaks its mint rules/;
    await expect(insert('platform', null, ['platform:users'], { mode: 'test' })).rejects.toThrow(
      broken,
    );
    await expect(insert('platform', null, ['platform:users'], { createdBy: null })).rejects.toThrow(
      broken,
    );
    for (const amr of ['breakglass', 'magic_link', null])
      await expect(insert('platform', null, ['platform:users'], { amr })).rejects.toThrow(broken);
    await expect(insert('platform', null, ['platform:users'], { days: 32 })).rejects.toThrow(
      broken,
    );
    await expect(insert('platform', null, ['platform:read'], { days: 90 })).resolves.toBeDefined();
    await expect(
      insert('platform', null, ['platform:read', 'platform:users'], { days: 90 }),
    ).rejects.toThrow(/platform and org scopes together|platform key breaks/);
  });
});

describe('a Platform key lives only while its creator is the admin who made it', () => {
  const admin = async () => {
    const user = await makeUser(f());
    await run(h.env.DB, `UPDATE users SET last_roles = '["admin"]' WHERE id = ?`, [user.id]);
    return user;
  };
  const make = async (createdBy: string, extra: object = {}) =>
    makeApiKey(f(), {
      orgId: null,
      kind: 'platform',
      scopes: ['platform:orgs'],
      expiresAt: h.clock.now() + 30 * DAY,
      ipAllow: ['198.51.100.0/24'],
      createdBy,
      ...extra,
    });
  const resolve = (secret: string, ip = '198.51.100.7') =>
    createApiKeyStore(h.env, h.clock).resolve(secret, {
      ip,
      browser: false,
      cookie: false,
    } as never);
  const status = (id: string, value: string) =>
    run(h.env.DB, 'UPDATE users SET status = ? WHERE id = ?', [value, id]);
  const refusals = () =>
    all<{ actor_id: string; org_id: string | null; detail: string }>(
      h.env.DB,
      "SELECT actor_id, org_id, detail FROM audit_log WHERE action = 'api_key.refused' ORDER BY id",
    );

  it('resolves inside its allowlist, and never outside it, past expiry, revoked or retired', async () => {
    const user = await admin();
    const key = await make(user.id);
    expect(await resolve(key.secret)).toMatchObject({ keyKind: 'platform', orgId: null });
    expect(await resolve(key.secret, '203.0.113.9')).toBeNull();
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [1, key.id]);
    expect(await resolve(key.secret)).toBeNull();
    const retiring = await make(user.id, { retireAt: h.clock.now() + 1000 });
    h.clock.advance(2000);
    expect(await resolve(retiring.secret)).toBeNull();
    const expired = await make(user.id, { expiresAt: h.clock.now() + 1000 });
    h.clock.advance(2000);
    expect(await resolve(expired.secret)).toBeNull();
  });

  it('dies when the creator is disabled, and a re-enable does not bring it back', async () => {
    const user = await admin();
    const key = await make(user.id);
    expect(await resolve(key.secret)).not.toBeNull();
    await status(user.id, 'disabled');
    expect(await resolve(key.secret)).toBeNull();
    await status(user.id, 'active');
    expect(await resolve(key.secret)).toBeNull();
  });

  it('dies when the admin role is taken: by the next sign-in without it, or by the removal itself', async () => {
    const user = await admin();
    const bySignIn = await make(user.id);
    const byRemoval = await make(user.id);
    expect(await resolve(bySignIn.secret)).not.toBeNull();
    await endAdminAccess(h.env.DB, user.id);
    expect(await resolve(bySignIn.secret)).toBeNull();
    expect(await resolve(byRemoval.secret)).toBeNull();
    // The person is given the role back (last_roles names admin again): the old keys stay dead, a new one lives.
    expect(await resolve((await make(user.id)).secret)).not.toBeNull();
    const other = await admin();
    const key = await make(other.id);
    await run(h.env.DB, `UPDATE users SET last_roles = '["user"]' WHERE id = ?`, [other.id]);
    expect(await resolve(key.secret)).toBeNull();
    await run(h.env.DB, `UPDATE users SET last_roles = '["admin"]' WHERE id = ?`, [other.id]);
    expect(await resolve(key.secret)).toBeNull();
  });

  it('is dead when its creator was never an admin, or is gone', async () => {
    const plain = await makeUser(f());
    expect(await resolve((await make(plain.id)).secret)).toBeNull();
    const user = await admin();
    const key = await make(user.id);
    await run(h.env.DB, 'DELETE FROM users WHERE id = ?', [user.id]).catch(() => undefined);
    await status(user.id, 'disabled').catch(() => undefined);
    expect(await resolve(key.secret)).toBeNull();
  });

  it('audits the refusal of a matching secret as the key, with the reason, and answers as before', async () => {
    const user = await admin();
    const key = await make(user.id);
    expect(await resolve(key.secret, '203.0.113.9')).toBeNull();
    await endAdminAccess(h.env.DB, user.id);
    expect(await resolve(key.secret)).toBeNull();
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [key.id]);
    expect(await resolve(key.secret)).toBeNull();
    const rows = (await refusals()).filter((r) => r.actor_id === key.id);
    expect(rows.map((r) => [r.actor_id, r.org_id, JSON.parse(r.detail).reason])).toEqual([
      [key.id, null, 'ip'],
      [key.id, null, 'creator'],
      [key.id, null, 'revoked'],
    ]);
    // A wrong secret is no matching secret: nothing is written for it, and none for an org key.
    expect(await resolve('pbo_nope_nope')).toBeNull();
    const orgKey = await makeApiKey(f(), { orgId: org.id });
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [orgKey.id]);
    expect(await resolve(orgKey.secret)).toBeNull();
    expect((await refusals()).filter((r) => r.actor_id === orgKey.id)).toHaveLength(0);
    expect((await refusals()).filter((r) => r.actor_id === key.id)).toHaveLength(3);
  });

  it('caps the rows an hour, apart from auth.denied', async () => {
    const note = () =>
      auditPlatformKeyRefusal(h.env, h.clock, {
        keyId: 'k',
        orgId: null,
        ipPrefix: null,
        detail: { reason: 'ip' },
      });
    await run(h.env.DB, "DELETE FROM counters WHERE key = 'audit:platform_key_refused'");
    await run(h.env.DB, "DELETE FROM audit_log WHERE action = 'api_key.refused'");
    for (let i = 0; i < 205; i++) await note();
    expect(await refusals()).toHaveLength(200);
  });
});

describe('a grant re-checks the creator at commit', () => {
  const commitStatus = async (
    s: Awaited<ReturnType<typeof setupGrant>>['s'],
    route: Awaited<ReturnType<typeof setupGrant>>['route'],
    keyId: string,
    status: string,
  ) => {
    const g = grant(route, {
      purpose: 'platform.org.status',
      principal: { kind: 'api_key', keyId, scope: 'platform:orgs' },
    });
    g.update('orgs', { set: { status }, where: { id: s.org.id } });
    return refusal(g.commit());
  };
  const platformKey = async (s: Awaited<ReturnType<typeof setupGrant>>['s']) => {
    const key = await makeApiKey(s.f, {
      orgId: null,
      kind: 'platform',
      scopes: ['platform:orgs'],
      expiresAt: s.f.clock.now() + 30 * DAY,
      ipAllow: ['198.51.100.0/24'],
    });
    return { key, creator: `creator-${key.id}` };
  };
  const orgStatus = async (s: Awaited<ReturnType<typeof setupGrant>>['s']) =>
    (
      await first<{ status: string }>(s.f.env.DB, 'SELECT status FROM orgs WHERE id = ?', [
        s.org.id,
      ])
    )?.status;

  it('commits for the admin, and refuses once they are disabled between the gate and the commit', async () => {
    const { s, route } = await setupGrant('pk-creator');
    const { key, creator } = await platformKey(s);
    expect(await commitStatus(s, route, key.id, 'suspended')).toBeNull();
    await run(s.f.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [creator]);
    expect(await commitStatus(s, route, key.id, 'active')).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(await orgStatus(s)).toBe('suspended');
    await run(s.f.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [creator]);
    expect(await commitStatus(s, route, key.id, 'active')).toMatchObject({ code: 'ACTOR_CHANGED' });
  });

  it('refuses once the creator is demoted between the gate and the commit, and for good', async () => {
    const { s, route } = await setupGrant('pk-demoted');
    const { key, creator } = await platformKey(s);
    await endAdminAccess(s.f.env.DB, creator);
    expect(await commitStatus(s, route, key.id, 'suspended')).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
    expect(await orgStatus(s)).not.toBe('suspended');
    // Signing in without the admin role, then being given it back, revives nothing.
    await run(s.f.env.DB, `UPDATE users SET last_roles = '[]' WHERE id = ?`, [creator]);
    await run(s.f.env.DB, `UPDATE users SET last_roles = '["admin"]' WHERE id = ?`, [creator]);
    expect(await commitStatus(s, route, key.id, 'suspended')).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
  });

  it('refuses a forged key row that names an org, even holding the scope', async () => {
    const { s, route } = await setupGrant('pk-forged');
    const id = crypto.randomUUID();
    const hash = await sha256Hex('x');
    await withoutTrigger(s.f.env.DB, 'api_keys_platform_scopes', () =>
      withoutTrigger(s.f.env.DB, 'api_keys_platform_key_rules', () =>
        withoutTrigger(s.f.env.DB, 'api_keys_kind_rules', () =>
          run(
            s.f.env.DB,
            `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, created_by)
           VALUES (?, ?, 'forged', 'frg', ?, '["platform:orgs"]', 'live', 1, 'platform', ?)`,
            [id, s.org.id, hash, s.user.id],
          ),
        ),
      ),
    );
    expect(await commitStatus(s, route, id, 'suspended')).toMatchObject({ code: 'ACTOR_CHANGED' });
  });
});

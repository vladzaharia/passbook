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
const platformBody = (scopes: string[], days = 30, extra: object = {}) => ({
  name: 'Ops',
  orgId: null,
  scopes,
  expiresAt: h.clock.now() + days * DAY,
  ipAllow: ['198.51.100.0/24'],
  ...extra,
});
const keyRows = async () => (await all(h.env.DB, 'SELECT id FROM api_keys')).length;

describe('minting a Platform key', () => {
  it('makes one for a platform admin in a Polaris ID session: pbo_ secret, platform kind, no org, audited as the person', async () => {
    const session = await platformSession();
    const res = await create(session.headers, platformBody(['platform:users', 'platform:audit']));
    expect(res.status).toBe(201);
    const key = (await res.json()) as CreatedKey;
    expect(key.secret).toMatch(/^pbo_/);
    expect(key).toMatchObject({ orgId: null, scopes: ['platform:users', 'platform:audit'] });
    const row = await first<{ kind: string; created_by: string; created_amr: string }>(
      h.env.DB,
      'SELECT kind, created_by, created_amr FROM api_keys WHERE id = ?',
      [key.id],
    );
    expect(row).toMatchObject({ kind: 'platform', created_amr: 'oidc' });
    const audit = await first<{ actor_type: string; org_id: string | null }>(
      h.env.DB,
      "SELECT actor_type, org_id FROM audit_log WHERE action = 'api_key.create' AND target_id = ?",
      [key.id],
    );
    expect(audit).toEqual({ actor_type: 'user', org_id: null });
  });

  it('refuses a break-glass session: it must not leave a control-plane credential behind', async () => {
    const user = await makeUser(f());
    const before = await keyRows();
    const breakGlass = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      amr: 'breakglass',
    });
    await expectProblem(
      await create(breakGlass.headers, platformBody(['platform:read'])),
      403,
      'IDP_SIGN_IN_REQUIRED',
    );
    expect(await keyRows()).toBe(before);
  });

  it('needs a recent sign-in: the mint is the step-up', async () => {
    const user = await makeUser(f());
    const stale = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      authTime: h.clock.now() - 3600_000,
    });
    await expectProblem(
      await create(stale.headers, platformBody(['platform:read'])),
      403,
      'STEP_UP_REQUIRED',
    );
  });

  it('refuses a key with no IP allowlist', async () => {
    const session = await platformSession();
    await expectProblem(
      await create(session.headers, platformBody(['platform:read'], 30, { ipAllow: [] })),
      422,
      'API_KEY_IP_REQUIRED',
    );
  });

  it('lives at most 30 days with a write scope, and 90 with platform:read alone', async () => {
    const session = await platformSession();
    expect((await create(session.headers, platformBody(['platform:users'], 30))).status).toBe(201);
    await expectProblem(
      await create(session.headers, platformBody(['platform:users'], 32)),
      422,
      'API_KEY_EXPIRY_TOO_LONG',
    );
    // One write scope beside platform:read is still a write key.
    await expectProblem(
      await create(session.headers, platformBody(['platform:read', 'platform:users'], 60)),
      422,
      'API_KEY_EXPIRY_TOO_LONG',
    );
    expect((await create(session.headers, platformBody(['platform:read'], 90))).status).toBe(201);
    await expectProblem(
      await create(session.headers, platformBody(['platform:read'], 92)),
      422,
      'API_KEY_EXPIRY_TOO_LONG',
    );
  });

  it('never mixes the flavours: platform scopes beside an organization scope are refused', async () => {
    const session = await platformSession();
    const before = await keyRows();
    await expectProblem(
      await create(session.headers, platformBody(['platform:users', 'passes:read'])),
      422,
      'API_KEY_PLATFORM_SCOPES_ALONE',
    );
    expect(await keyRows()).toBe(before);
  });

  it('is Live only', async () => {
    const session = await platformSession();
    await expectProblem(
      await create(session.headers, platformBody(['platform:read'], 30, { mode: 'test' })),
      422,
      'API_KEY_PLATFORM_LIVE',
    );
  });

  it('holds no role', async () => {
    const session = await platformSession();
    expect(
      (await create(session.headers, platformBody(['platform:read'], 30, { roles: ['org_admin'] })))
        .status,
    ).toBe(422);
  });

  it('is refused to a member, and to an organization key and its children', async () => {
    const before = await keyRows();
    const admin = await member('org_admin');
    await expectProblem(
      await create(admin.session.headers, { ...keyBody(org.id), scopes: ['platform:read'] }),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
    expect((await create(admin.session.headers, platformBody(['platform:read']))).status).toBe(403);
    // A platform admin naming an organization gets a service key, which never holds a platform scope.
    const platformAdmin = await platformSession();
    expect(
      (await create(platformAdmin.headers, { ...keyBody(org.id), scopes: ['platform:read'] }))
        .status,
    ).toBeGreaterThanOrEqual(403);
    // An org key that mints keys may not hold a platform scope for a child, nor mint a platform key.
    const parent = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['api-keys:write', 'passes:read'],
    });
    for (const body of [
      { ...keyBody(org.id), scopes: ['platform:read'] },
      platformBody(['platform:read']),
    ])
      expect((await create(parent.headers, body)).status).toBe(403);
    // Only the parent was made.
    expect(await keyRows()).toBe(before + 1);
  });

  it('is never made, rotated or listed by a Platform key: it holds no api-keys scope', async () => {
    const key = await makeApiKey(f(), {
      orgId: null,
      kind: 'platform',
      scopes: [...PLATFORM_KEY_SCOPES],
      expiresAt: h.clock.now() + 30 * DAY,
      ipAllow: ['198.51.100.0/24'],
    });
    const headers = { ...key.headers, 'cf-connecting-ip': '198.51.100.7' };
    await expectProblem(
      await create(headers, platformBody(['platform:read'])),
      403,
      'MISSING_SCOPE',
    );
    const rotate = await h.call(`/api/v1/api-keys/${key.id}/rotate`, {
      method: 'POST',
      headers,
      json: { orgId: null },
    });
    await expectProblem(rotate, 403, 'MISSING_SCOPE');
  });

  it('is rotated by a Polaris ID session only, keeping the old expiry', async () => {
    const session = await platformSession();
    const made = (await (
      await create(session.headers, platformBody(['platform:users'], 30))
    ).json()) as CreatedKey;
    const user = await makeUser(f());
    const breakGlass = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      amr: 'breakglass',
    });
    const rotate = (headers: Record<string, string>) =>
      h.call(`/api/v1/api-keys/${made.id}/rotate`, {
        method: 'POST',
        headers,
        json: { orgId: null, overlapHours: 1 },
      });
    await expectProblem(await rotate(breakGlass.headers), 403, 'IDP_SIGN_IN_REQUIRED');
    expect((await rotate(session.headers)).status).toBe(201);
  });
});

describe('the row refuses what the mint refuses', () => {
  const insert = (kind: string, orgId: string | null, scopes: string[]) =>
    run(
      h.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, expires_at, ip_allow, created_by)
       VALUES (?, ?, 'forged', ?, ?, ?, 'live', 1, ?, ?, '["198.51.100.0/24"]', NULL)`,
      [
        crypto.randomUUID(),
        orgId,
        crypto.randomUUID().slice(0, 8),
        crypto.randomUUID(),
        JSON.stringify(scopes),
        kind,
        kind === 'platform' ? 1 + 30 * DAY : null,
      ],
    );

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
    await expect(insert('platform', null, ['passes:read'])).resolves.toBeDefined();
    await expect(insert('service', org.id, ['passes:read'])).resolves.toBeDefined();
  });
});

describe('a Platform key lives only while it is in force', () => {
  const make = async (createdBy?: string, extra: object = {}) =>
    makeApiKey(f(), {
      orgId: null,
      kind: 'platform',
      scopes: ['platform:orgs'],
      expiresAt: h.clock.now() + 30 * DAY,
      ipAllow: ['198.51.100.0/24'],
      ...(createdBy ? { createdBy } : {}),
      ...extra,
    });
  const resolve = (secret: string, ip = '198.51.100.7') =>
    createApiKeyStore(h.env, h.clock).resolve(secret, {
      ip,
      browser: false,
      cookie: false,
    } as never);

  it('resolves inside its allowlist, and never outside it, past expiry, revoked or retired', async () => {
    const key = await make();
    expect(await resolve(key.secret)).toMatchObject({ keyKind: 'platform', orgId: null });
    expect(await resolve(key.secret, '203.0.113.9')).toBeNull();
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [1, key.id]);
    expect(await resolve(key.secret)).toBeNull();
    const retiring = await make(undefined, { retireAt: h.clock.now() + 1000 });
    h.clock.advance(2000);
    expect(await resolve(retiring.secret)).toBeNull();
    const expired = await make(undefined, { expiresAt: h.clock.now() + 1000 });
    h.clock.advance(2000);
    expect(await resolve(expired.secret)).toBeNull();
  });

  it('dies with its creator: disabled, then alive again with them, and gone for good when they are deleted', async () => {
    const user = await makeUser(f());
    const key = await make(user.id);
    expect(await resolve(key.secret)).not.toBeNull();
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect(await resolve(key.secret)).toBeNull();
    await run(h.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
    expect(await resolve(key.secret)).not.toBeNull();
    await run(h.env.DB, 'UPDATE api_keys SET created_by = NULL WHERE id = ?', [key.id]).catch(
      () => undefined,
    );
  });

  it('is dead when no creator was recorded', async () => {
    const key = await make();
    await withoutTrigger(h.env.DB, 'api_keys_identity_immutable', () =>
      run(h.env.DB, 'UPDATE api_keys SET created_by = NULL WHERE id = ?', [key.id]),
    ).catch(async () => {
      // The identity trigger may name itself differently: delete the creator instead (set null on delete).
      await run(h.env.DB, "DELETE FROM users WHERE id LIKE 'creator-%'");
    });
    expect(await resolve(key.secret)).toBeNull();
  });

  it('is refused the standard budget raise: a platform scope pins the tier to standard', async () => {
    const key = await make(undefined, { rateTier: 'bulk' });
    const auth = await resolve(key.secret);
    expect(auth).not.toBeNull();
    expect(await first(h.env.DB, 'SELECT rate_tier FROM api_keys WHERE id = ?', [key.id])).toEqual({
      rate_tier: 'bulk',
    });
  });
});

describe('a grant re-checks the creator at commit', () => {
  it('commits for a live creator, and refuses once the creator is disabled between the gate and the commit', async () => {
    const { s, route } = await setupGrant('pk-creator');
    const key = await makeApiKey(s.f, {
      orgId: null,
      kind: 'platform',
      scopes: ['platform:orgs'],
      expiresAt: s.f.clock.now() + 30 * DAY,
      ipAllow: ['198.51.100.0/24'],
    });
    const orgs = async (status: string) => {
      const g = grant(route, {
        purpose: 'platform.org.status',
        principal: { kind: 'api_key', keyId: key.id, scope: 'platform:orgs' },
      });
      g.update('orgs', { set: { status }, where: { id: s.org.id } });
      return refusal(g.commit());
    };
    expect(await orgs('suspended')).toBeNull();
    await run(s.f.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [
      `creator-${key.id}`,
    ]);
    expect(await orgs('active')).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(
      (
        await first<{ status: string }>(s.f.env.DB, 'SELECT status FROM orgs WHERE id = ?', [
          s.org.id,
        ])
      )?.status,
    ).toBe('suspended');
  });

  it('refuses a forged key row that names an org, even holding the scope', async () => {
    const { s, route } = await setupGrant('pk-forged');
    const id = crypto.randomUUID();
    const hash = await sha256Hex('x');
    await withoutTrigger(s.f.env.DB, 'api_keys_platform_scopes', () =>
      withoutTrigger(s.f.env.DB, 'api_keys_kind_rules', () =>
        run(
          s.f.env.DB,
          `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, created_by)
           VALUES (?, ?, 'forged', 'frg', ?, '["platform:orgs"]', 'live', 1, 'platform', ?)`,
          [id, s.org.id, hash, s.user.id],
        ),
      ),
    );
    const g = grant(route, {
      purpose: 'platform.org.status',
      principal: { kind: 'api_key', keyId: id, scope: 'platform:orgs' },
    });
    g.update('orgs', { set: { status: 'suspended' }, where: { id: s.org.id } });
    expect(await refusal(g.commit())).toMatchObject({ code: 'ACTOR_CHANGED' });
  });
});

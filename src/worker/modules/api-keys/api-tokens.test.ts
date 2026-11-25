import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
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
  revoke,
  setup,
  teardown,
} from './test-kit.ts';

beforeEach(async () => {
  await setup();
  // Storage lasts for the whole file; these tests count keys and audit rows.
  await run(h.env.DB, 'DELETE FROM api_keys');
  await run(h.env.DB, 'DELETE FROM audit_log');
});
afterEach(teardown);

const DAY = 86_400_000;
const NET = { ipAllow: ['198.51.100.0/24'] };
const orgBody = (over: object = {}) => ({
  ...keyBody(org.id),
  scopes: ['templates:read'],
  ...over,
});
const mint = async (role: 'org_admin' | 'integration_admin', over: object = {}) => {
  const { session } = await member(role);
  const res = await create(session.headers, orgBody(over));
  return { res, session, key: (await res.clone().json()) as CreatedKey };
};
const row = (id: string) =>
  first<Record<string, string | number | null>>(h.env.DB, 'SELECT * FROM api_keys WHERE id = ?', [
    id,
  ]);

describe('token prefixes', () => {
  it('names the kind and mode in the secret, and stores only a hash of it', async () => {
    const live = await mint('integration_admin');
    expect(live.key.secret).toMatch(/^pb_live_[\w-]{8}_[\w-]{43}$/);
    const { session } = await member('integration_admin');
    const test = (await (
      await create({ ...session.headers, 'x-passbook-mode': 'test' }, orgBody())
    ).json()) as CreatedKey;
    expect(test.secret).toMatch(/^pb_test_[\w-]{8}_[\w-]{43}$/);
    const platform = (await (
      await create((await platformSession()).headers, { ...keyBody(null), ...NET })
    ).json()) as CreatedKey;
    expect(platform.secret).toMatch(/^pbo_live_[\w-]{8}_[\w-]{43}$/);
    const stored = await row(live.key.id);
    expect(JSON.stringify(stored)).not.toContain(live.key.secret);
    // The random part is the fixed 43 characters after the prefix (base64url, so it may itself hold `_`).
    const random = live.key.secret.slice(-43);
    expect(random).toHaveLength(43);
    expect(JSON.stringify(stored)).not.toContain(random);
    // The row carries the prefix and the hash, nothing of the secret.
    expect(stored?.prefix).toBe(live.key.secret.slice('pb_live_'.length).slice(0, 8));
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never carries the secret into the audit row or a list', async () => {
    const { key, session } = await mint('integration_admin');
    const audit = await all<{ detail: string }>(
      h.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'api_key.create'",
    );
    expect(JSON.stringify(audit)).not.toContain(key.secret);
    const listed = await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers: session.headers });
    expect(await listed.text()).not.toContain(key.secret);
  });
});

describe('roles', () => {
  it('mints a role key with no scopes, and the audit row records the role', async () => {
    const { res, key } = await mint('org_admin', { scopes: [], roles: ['pass_operator'] });
    expect(res.status).toBe(201);
    expect(key).toMatchObject({ roles: ['pass_operator'], kind: 'service' });
    expect(key.scopes).toContain('passes:write');
    expect(
      await first(
        h.env.DB,
        "SELECT detail FROM audit_log WHERE action = 'api_key.create' AND target_id = ?",
        [key.id],
      ),
    ).toMatchObject({ detail: expect.stringContaining('pass_operator') });
  });

  it('needs at least one scope or role', async () => {
    const { session } = await member('org_admin');
    const res = await create(session.headers, orgBody({ scopes: [], roles: [] }));
    await expectProblem(res, 422, 'API_KEY_SCOPES_REQUIRED');
  });

  it('a creator cannot give a role above their own', async () => {
    const { session } = await member('integration_admin');
    for (const roles of [['org_admin'], ['pass_operator'], ['integration_admin', 'read_only']])
      await expectProblem(
        await create(session.headers, orgBody({ scopes: [], roles })),
        403,
        'API_KEY_SCOPE_EXCEEDS_CREATOR',
      );
    expect(
      (await create(session.headers, orgBody({ scopes: [], roles: ['integration_admin'] }))).status,
    ).toBe(201);
    expect(
      (await create(session.headers, orgBody({ scopes: [], roles: ['read_only'] }))).status,
    ).toBe(403);
    expect(
      await all(h.env.DB, "SELECT 1 FROM api_keys WHERE roles <> '[]' AND org_id = ?", [org.id]),
    ).toHaveLength(1);
  });

  it('a role key holds the role at request time and nothing more', async () => {
    const { key } = await mint('org_admin', { scopes: [], roles: ['template_author'] });
    const auth = await createApiKeyStore(h.env, h.clock).resolve(key.secret);
    // A role holds the scopes a route accepts; a scope gained later reaches the role then.
    expect(auth?.scopes).toEqual(['templates:read', 'templates:write', 'org:read']);
    // The bundle is written onto the key at mint; the role is only a label.
    expect(JSON.parse(String((await row(key.id))?.scopes))).toEqual([
      'templates:read',
      'templates:write',
      'org:read',
    ]);
    expect((key as CreatedKey & { roles: string[] }).roles).toEqual(['template_author']);
    const headers = { authorization: `Bearer ${key.secret}` };
    expect((await h.call('/api/v1/templates', { headers })).status).toBe(200);
    await expectProblem(await h.call('/api/v1/passes', { headers }), 403, 'MISSING_SCOPE');
  });
});

describe('a role is a label on the scopes written at mint', () => {
  it('a key keeps exactly the scopes it has, whatever its role bundle holds now', async () => {
    // A key made when the pass_operator bundle held one scope: the bundle has grown since.
    const old = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['passes:read'],
      roles: ['pass_operator'],
    });
    const auth = await createApiKeyStore(h.env, h.clock).resolve(old.secret);
    expect(auth?.scopes).toEqual(['passes:read']);
    const headers = old.headers;
    expect((await h.call('/api/v1/passes', { headers })).status).toBe(200);
    await expectProblem(
      await h.call('/api/v1/passes', { method: 'POST', headers, json: {} }),
      403,
      'MISSING_SCOPE',
    );
  });

  it('copies the bundle at mint, so a new key holds all of it', async () => {
    const { key } = await mint('org_admin', { scopes: [], roles: ['pass_operator'] });
    expect([...key.scopes].sort()).toEqual([
      'holders:write',
      'messages:write',
      'org:read',
      'passes:read',
      'passes:write',
      'scan-setup:read',
      'scans:read',
      'templates:read',
    ]);
  });
});

describe('personal keys', () => {
  const personal = (over: object = {}) =>
    orgBody({ kind: 'personal', expiresAt: h.clock.now() + 30 * DAY, ...over });

  it('any member mints their own, within their role, and may end it', async () => {
    const { session, membershipId } = await member('pass_operator');
    const res = await create(session.headers, personal());
    expect(res.status).toBe(201);
    const key = (await res.json()) as CreatedKey & { kind: string };
    expect(key.secret).toMatch(/^pbp_live_/);
    expect(await row(key.id)).toMatchObject({ kind: 'personal', membership_id: membershipId });
    expect((await revoke(session.headers, key.id, org.id)).status).toBe(200);
    expect(await row(key.id)).toMatchObject({ revoked_at: expect.any(Number) });
  });

  it('is capped by the member role at mint and in use', async () => {
    const { session } = await member('pass_operator');
    await expectProblem(
      await create(session.headers, personal({ scopes: ['connections:write'] })),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
    await expectProblem(
      await create(session.headers, personal({ scopes: [], roles: ['integration_admin'] })),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
    const ok = (await (
      await create(session.headers, personal({ scopes: [], roles: ['pass_operator'] }))
    ).json()) as CreatedKey;
    const auth = await createApiKeyStore(h.env, h.clock).resolve(ok.secret);
    expect(auth?.scopes).not.toContain('connections:read');
    expect(auth?.scopes).toContain('passes:read');
  });

  it('needs an expiry of at most 90 days, and never a terminal scope', async () => {
    const { session } = await member('pass_operator');
    await expectProblem(
      await create(session.headers, orgBody({ kind: 'personal' })),
      422,
      'API_KEY_EXPIRY_REQUIRED',
    );
    await expectProblem(
      await create(session.headers, personal({ expiresAt: h.clock.now() + 120 * DAY })),
      422,
      'API_KEY_EXPIRY_TOO_LONG',
    );
    await expectProblem(
      await create(session.headers, personal({ scopes: ['scans:write'], terminalIds: [] })),
      422,
      'API_KEY_KIND_SCOPE',
    );
  });

  it('dies with its membership and with its user, at the next request', async () => {
    const a = await member('pass_operator');
    const b = await member('pass_operator');
    const keyA = (await (await create(a.session.headers, personal())).json()) as CreatedKey;
    const keyB = (await (await create(b.session.headers, personal())).json()) as CreatedKey;
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(keyA.secret)).not.toBeNull();
    expect(await store.resolve(keyB.secret)).not.toBeNull();
    await run(h.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      h.clock.now(),
      a.membershipId,
    ]);
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [b.user.id]);
    expect(await store.resolve(keyA.secret)).toBeNull();
    expect(await store.resolve(keyB.secret)).toBeNull();
    for (const k of [keyA, keyB])
      expect(
        (await h.call('/api/v1/passes', { headers: { authorization: `Bearer ${k.secret}` } }))
          .status,
      ).toBe(401);
  });

  it('another member cannot end it, and a manager can', async () => {
    const owner = await member('pass_operator');
    const other = await member('pass_operator');
    const manager = await member('integration_admin');
    const key = (await (await create(owner.session.headers, personal())).json()) as CreatedKey;
    await expectProblem(await revoke(other.session.headers, key.id, org.id), 403, 'FORBIDDEN');
    expect(await row(key.id)).toMatchObject({ revoked_at: null });
    expect((await revoke(manager.session.headers, key.id, org.id)).status).toBe(200);
  });

  it('a member cannot end a service key they did not make', async () => {
    const { key } = await mint('integration_admin');
    const { session } = await member('pass_operator');
    await expectProblem(await revoke(session.headers, key.id, org.id), 403, 'FORBIDDEN');
  });

  it('is not minted for another org or without a session', async () => {
    const { session } = await member('pass_operator');
    const res = await create(session.headers, personal({ orgId: null }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await all(h.env.DB, "SELECT 1 FROM api_keys WHERE kind = 'personal'")).toEqual([]);
  });
});

describe('a member without integrations:read and their own personal keys', () => {
  const personal = (over: object = {}) =>
    orgBody({ kind: 'personal', expiresAt: h.clock.now() + 30 * DAY, ...over });
  const ids = async (headers: Record<string, string>, state = '') => {
    const r = await h.call(`/api/v1/api-keys?orgId=${org.id}${state}`, { headers });
    expect(r.status).toBe(200);
    const page = (await r.json()) as { items: { id: string }[]; revokedCount: number };
    return { ids: page.items.map((i) => i.id), revoked: page.revokedCount };
  };

  it("lists only their own personal keys: never another member's or a service key", async () => {
    const a = await member('template_author');
    const b = await member('template_author');
    const keyA = (await (await create(a.session.headers, personal())).json()) as CreatedKey;
    const keyB = (await (await create(b.session.headers, personal())).json()) as CreatedKey;
    const service = await mint('integration_admin');
    expect((await ids(a.session.headers)).ids).toEqual([keyA.id]);
    expect((await ids(b.session.headers)).ids).toEqual([keyB.id]);
    for (const query of ['&state=live', '&state=revoked', '&limit=1'])
      expect((await ids(a.session.headers, query)).ids).not.toContain(keyB.id);
    expect((await ids(a.session.headers)).ids).not.toContain(service.key.id);
    // A manager still sees every key of the org.
    expect((await ids(service.session.headers)).ids).toEqual(
      expect.arrayContaining([keyA.id, keyB.id, service.key.id]),
    );
  });

  it('counts only their own revoked keys, and nothing leaks through the cursor', async () => {
    const a = await member('template_author');
    const b = await member('template_author');
    const first = (await (await create(a.session.headers, personal())).json()) as CreatedKey;
    const second = (await (await create(a.session.headers, personal())).json()) as CreatedKey;
    const other = (await (await create(b.session.headers, personal())).json()) as CreatedKey;
    await revoke(b.session.headers, other.id, org.id);
    await revoke(a.session.headers, first.id, org.id);
    expect((await ids(a.session.headers)).revoked).toBe(1);
    const paged = await h.call(`/api/v1/api-keys?orgId=${org.id}&limit=1&cursor=${other.id}`, {
      headers: a.session.headers,
    });
    const body = (await paged.json()) as { items: { id: string }[] };
    expect(body.items.every((i) => [first.id, second.id].includes(i.id))).toBe(true);
  });

  it('is refused for a non-member, and an org they are not in stays closed', async () => {
    const outsider = await platformSession();
    await expectProblem(
      await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers: outsider.headers }),
      403,
      'FORBIDDEN',
    );
  });

  it("retires their own personal key, but not another member's or a service key", async () => {
    const a = await member('template_author');
    const b = await member('template_author');
    const own = (await (await create(a.session.headers, personal())).json()) as CreatedKey;
    const theirs = (await (await create(b.session.headers, personal())).json()) as CreatedKey;
    const service = await mint('integration_admin');
    const retire = (id: string) =>
      h.call(`/api/v1/api-keys/${id}/retire`, {
        method: 'POST',
        headers: a.session.headers,
        json: { orgId: org.id, retireAt: h.clock.now() + DAY },
      });
    expect((await retire(own.id)).status).toBe(200);
    await expectProblem(await retire(theirs.id), 403, 'FORBIDDEN');
    await expectProblem(await retire(service.key.id), 403, 'FORBIDDEN');
    expect((await row(theirs.id))?.retire_at).toBeNull();
    expect((await row(service.key.id))?.retire_at).toBeNull();
    expect((await row(own.id))?.retire_at).toBe(h.clock.now() + DAY);
  });
});

describe('platform keys', () => {
  it('need an expiry within 90 days and an IP allowlist, and hold no roles', async () => {
    const { headers } = await platformSession();
    const body = (over: object) => ({ ...keyBody(null), ...NET, ...over });
    await expectProblem(
      await create(headers, body({ expiresAt: null })),
      422,
      'API_KEY_EXPIRY_REQUIRED',
    );
    await expectProblem(
      await create(headers, body({ expiresAt: h.clock.now() + 120 * DAY })),
      422,
      'API_KEY_EXPIRY_TOO_LONG',
    );
    await expectProblem(await create(headers, body({ ipAllow: [] })), 422, 'API_KEY_IP_REQUIRED');
    await expectProblem(
      await create(headers, body({ roles: ['org_admin'] })),
      422,
      'API_KEY_ROLES_ORG_ONLY',
    );
    expect((await create(headers, body({}))).status).toBe(201);
  });

  it('cannot be written as a service key, or a service key as platform', async () => {
    const { headers } = await platformSession();
    await expectProblem(
      await create(headers, { ...keyBody(null), ...NET, kind: 'service' }),
      422,
      'API_KEY_KIND_INVALID',
    );
    const { session } = await member('integration_admin');
    await expectProblem(
      await create(session.headers, orgBody({ kind: 'platform' })),
      422,
      'API_KEY_KIND_INVALID',
    );
  });
});

describe('retire_at', () => {
  const retire = (headers: Record<string, string>, id: string, retireAt: number) =>
    h.call(`/api/v1/api-keys/${id}/retire`, {
      method: 'POST',
      headers,
      json: { orgId: org.id, retireAt },
    });

  it('ends the key at that instant, once, and audits it', async () => {
    const { key, session } = await mint('integration_admin');
    const at = h.clock.now() + 2 * DAY;
    expect((await retire(session.headers, key.id, at)).status).toBe(200);
    const store = createApiKeyStore(h.env, h.clock);
    h.clock.advance(2 * DAY - 1);
    expect(await store.resolve(key.secret)).not.toBeNull();
    h.clock.advance(1);
    expect(await store.resolve(key.secret)).toBeNull();
    expect(
      await first(
        h.env.DB,
        "SELECT actor_id FROM audit_log WHERE action = 'api_key.retire' AND target_id = ?",
        [key.id],
      ),
    ).not.toBeNull();
  });

  it('is set once, in the future, and never after expiry', async () => {
    const { key, session } = await mint('integration_admin', {
      expiresAt: h.clock.now() + 5 * DAY,
    });
    await expectProblem(
      await retire(session.headers, key.id, h.clock.now() - 1),
      422,
      'RETIRE_PAST',
    );
    await expectProblem(
      await retire(session.headers, key.id, h.clock.now() + 6 * DAY),
      422,
      'RETIRE_AFTER_EXPIRY',
    );
    expect((await retire(session.headers, key.id, h.clock.now() + DAY)).status).toBe(200);
    await expectProblem(
      await retire(session.headers, key.id, h.clock.now() + 2 * DAY),
      409,
      'API_KEY_RETIRE_SET',
    );
    expect((await row(key.id))?.retire_at).toBe(h.clock.now() + DAY);
  });

  it('needs integrations:manage in the key org, and a revoked key cannot be retired', async () => {
    const { key, session } = await mint('integration_admin');
    const operator = await member('pass_operator');
    await expectProblem(
      await retire(operator.session.headers, key.id, h.clock.now() + DAY),
      403,
      'FORBIDDEN',
    );
    await revoke(session.headers, key.id, org.id);
    await expectProblem(
      await retire(session.headers, key.id, h.clock.now() + DAY),
      409,
      'API_KEY_RETIRE_SET',
    );
    expect((await row(key.id))?.retire_at).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeSession } from '../../../../test/helpers/index.ts';
import { KEY_EXPIRY_DAYS } from '../../../shared/developers-keys.ts';
import { run } from '../../platform/db.ts';
import { create, f, h, member, org, platformSession, setup, teardown } from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM api_keys');
});
afterEach(teardown);

const DAY = 86_400_000;
const body = (over: object = {}) => ({
  orgId: org.id,
  name: 'Door admin',
  scopes: ['scanning:admin'],
  expiresAt: h.clock.now() + 30 * DAY,
  ...over,
});

describe('minting a credential scope (scanning:admin)', () => {
  it('is minted by an org_admin session with Polaris ID and a fresh step-up', async () => {
    const { session } = await member('org_admin');
    expect((await create(session.headers, body())).status).toBe(201);
  });

  it('takes a credential key at each developer-portal expiry (all within the 90-day cap)', async () => {
    const { session } = await member('org_admin');
    for (const days of KEY_EXPIRY_DAYS)
      expect(
        (
          await create(
            session.headers,
            body({ name: `Door ${days}`, expiresAt: h.clock.now() + days * DAY }),
          )
        ).status,
      ).toBe(201);
  });

  it('is refused for a member without scanning:manage', async () => {
    const { session } = await member('pass_operator');
    await expectProblem(await create(session.headers, body()), 403, 'FORBIDDEN');
  });

  it('is refused without Polaris ID sign-in and without a recent step-up', async () => {
    const { user } = await member('org_admin');
    const email = await makeSession(f(), { userId: user.id, roles: ['user'], amr: 'magic_link' });
    await expectProblem(await create(email.headers, body()), 403, 'IDP_SIGN_IN_REQUIRED');
    const stale = await makeSession(f(), {
      userId: user.id,
      roles: ['user'],
      authTime: h.clock.now() - 3_600_000,
    });
    await expectProblem(await create(stale.headers, body()), 403, 'STEP_UP_REQUIRED');
  });

  it('is refused for a key, and for a child of a key', async () => {
    const parent = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['api-keys:write', 'scanning:admin'],
    });
    const asKey = (json: object) =>
      h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: { authorization: `Bearer ${parent.secret}` },
        json,
      });
    await expectProblem(
      await asKey({ orgId: org.id, name: 'Child', scopes: ['scanning:admin'] }),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  });

  it('is refused in test mode, on a platform key, without an expiry, and past 90 days', async () => {
    const { session } = await member('org_admin');
    await expectProblem(
      await create({ ...session.headers, 'x-passbook-mode': 'test' }, body({ mode: 'test' })),
      422,
      'API_KEY_CREDENTIAL_LIVE_ORG',
    );
    const platform = await platformSession();
    await expectProblem(
      await create(platform.headers, body({ orgId: null, ipAllow: ['198.51.100.0/24'] })),
      422,
      'API_KEY_CREDENTIAL_LIVE_ORG',
    );
    await expectProblem(
      await create(session.headers, body({ expiresAt: null })),
      422,
      'API_KEY_EXPIRY_REQUIRED',
    );
    await expectProblem(
      await create(session.headers, body({ expiresAt: h.clock.now() + 95 * DAY })),
      422,
      'API_KEY_EXPIRY_TOO_LONG',
    );
  });

  it('is never in a role: an org_admin role token holds scanning:write only', async () => {
    const { session } = await member('org_admin');
    const res = await create(session.headers, {
      orgId: org.id,
      name: 'Role',
      scopes: [],
      roles: ['org_admin'],
    });
    expect(res.status).toBe(201);
    const key = (await res.json()) as { scopes: string[] };
    expect(key.scopes).toContain('scanning:write');
    expect(key.scopes).not.toContain('scanning:admin');
  });

  it('refuses a pass_operator or integration_admin asking for it, personal key included', async () => {
    const admin = await member('integration_admin');
    await expectProblem(
      await create(admin.session.headers, body()),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
    const { session } = await member('pass_operator');
    await expectProblem(
      await create(session.headers, body({ kind: 'personal' })),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  });

  it('rotates only with an expiry of at most 90 days left: the key itself, or a session', async () => {
    const { session } = await member('org_admin');
    const stored = async (expiresAt: number | null, scopes = ['scanning:admin']) => {
      const k = await makeApiKey(f(), { orgId: org.id, scopes, expiresAt: expiresAt ?? undefined });
      return k;
    };
    const rotate = (headers: Record<string, string>, id: string) =>
      h.call(`/api/v1/api-keys/${id}/rotate`, {
        method: 'POST',
        headers,
        json: { orgId: org.id },
      });
    const none = await stored(null);
    await expectProblem(await rotate(session.headers, none.id), 422, 'API_KEY_EXPIRY_REQUIRED');
    const far = await stored(h.clock.now() + 200 * DAY);
    await expectProblem(await rotate(session.headers, far.id), 422, 'API_KEY_EXPIRY_TOO_LONG');
    const self = await stored(null, ['scanning:admin', 'api-keys:write']);
    await expectProblem(
      await rotate({ authorization: `Bearer ${self.secret}` }, self.id),
      422,
      'API_KEY_EXPIRY_REQUIRED',
    );
    const ok = await stored(h.clock.now() + 30 * DAY);
    expect((await rotate(session.headers, ok.id)).status).toBe(201);
  });

  it('ignores the scope on a stored key that breaks the mint rule, and honours a compliant one', async () => {
    const scopes = ['scanning:admin', 'passes:read'];
    const setup = async (key: { secret: string }) =>
      (
        await h.call('/api/v1/scanning-sessions/setup', {
          method: 'POST',
          headers: { authorization: `Bearer ${key.secret}` },
          json: { orgId: org.id },
        })
      ).status;
    const good = await makeApiKey(f(), {
      orgId: org.id,
      scopes,
      expiresAt: h.clock.now() + 30 * DAY,
    });
    const bad = [
      await makeApiKey(f(), { orgId: org.id, scopes }),
      await makeApiKey(f(), { orgId: org.id, scopes, expiresAt: h.clock.now() + 200 * DAY }),
      await makeApiKey(f(), {
        orgId: org.id,
        scopes,
        roles: ['org_admin'],
        expiresAt: h.clock.now() + 30 * DAY,
      }),
    ];
    for (const key of bad) {
      expect(await setup(key)).toBe(403);
    }
    expect(await setup(good)).not.toBe(403);
  });
});

describe('minting a credential scope (nfc:keys)', () => {
  const nfc = (over: object = {}) => body({ name: 'Tag keys', scopes: ['nfc:keys'], ...over });

  it('is minted by an org_admin session, and refused for the other mint rules', async () => {
    const { session } = await member('org_admin');
    expect((await create(session.headers, nfc())).status).toBe(201);
    await expectProblem(
      await create({ ...session.headers, 'x-passbook-mode': 'test' }, nfc({ mode: 'test' })),
      422,
      'API_KEY_CREDENTIAL_LIVE_ORG',
    );
    await expectProblem(
      await create(session.headers, nfc({ expiresAt: null })),
      422,
      'API_KEY_EXPIRY_REQUIRED',
    );
    await expectProblem(
      await create(session.headers, nfc({ expiresAt: h.clock.now() + 95 * DAY })),
      422,
      'API_KEY_EXPIRY_TOO_LONG',
    );
    const operator = await member('pass_operator');
    await expectProblem(await create(operator.session.headers, nfc()), 403, 'FORBIDDEN');
  });

  it('is refused without Polaris ID sign-in and without a recent step-up', async () => {
    const { user } = await member('org_admin');
    const email = await makeSession(f(), { userId: user.id, roles: ['user'], amr: 'magic_link' });
    await expectProblem(await create(email.headers, nfc()), 403, 'IDP_SIGN_IN_REQUIRED');
    const stale = await makeSession(f(), {
      userId: user.id,
      roles: ['user'],
      authTime: h.clock.now() - 3_600_000,
    });
    await expectProblem(await create(stale.headers, nfc()), 403, 'STEP_UP_REQUIRED');
  });

  it('is never minted by a key, and never in a role', async () => {
    const parent = await makeApiKey(f(), { orgId: org.id, scopes: ['api-keys:write', 'nfc:keys'] });
    await expectProblem(
      await h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: { authorization: `Bearer ${parent.secret}` },
        json: { orgId: org.id, name: 'Child', scopes: ['nfc:keys'] },
      }),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
    const { session } = await member('org_admin');
    const res = await create(session.headers, {
      orgId: org.id,
      name: 'Role',
      scopes: [],
      roles: ['org_admin'],
    });
    expect(((await res.json()) as { scopes: string[] }).scopes).not.toContain('nfc:keys');
  });
});

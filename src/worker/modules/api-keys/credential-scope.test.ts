import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeSession } from '../../../../test/helpers/index.ts';
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
      'API_KEY_SCANNING_ADMIN_LIVE_ORG',
    );
    const platform = await platformSession();
    await expectProblem(
      await create(platform.headers, body({ orgId: null, ipAllow: ['198.51.100.0/24'] })),
      422,
      'API_KEY_SCANNING_ADMIN_LIVE_ORG',
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
});

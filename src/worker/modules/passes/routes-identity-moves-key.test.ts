// Platform-keys PK-6c: the identity-move reads take a Platform key; the writes stay a person's.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { type BroadcastAuth, type BroadcastKit, broadcastAuth } from '../broadcasts/test-kit.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import { moveKit, orgWithPasses } from './identity-move-test-fixtures.ts';

vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { wrapResolver } = await import('./identity-move-resolver-test-fixtures.ts');
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrapResolver(original.createIdentityResolver(...a)),
  };
});

const BASE = '/api/v1/platform/apple/identity-moves';
let kit: BroadcastKit;
let auth: BroadcastAuth;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await moveKit();
  auth = await broadcastAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const call = (path: string, headers: Record<string, string>, method = 'GET') =>
  app.request(`${BASE}${path}`, { method, headers }, kit.env);
const preview = (orgId: string) =>
  `/preview?orgId=${orgId}&fromIdentityId=platform&toIdentityId=${SECOND_ID}`;

async function platformKey(scopes: string[]) {
  const key = await makeApiKey(kit.fx, {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: kit.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return { ...key.headers, 'cf-connecting-ip': '198.51.100.7' };
}

describe('a Platform key on the identity-move reads', () => {
  it('reads the list and the preview with platform:identities or platform:read, and a person still can', async () => {
    const { org } = await orgWithPasses(kit, 1);
    for (const scope of ['platform:identities', 'platform:read']) {
      const headers = await platformKey([scope]);
      expect((await call('', headers)).status, scope).toBe(200);
      const res = await call(preview(org.id), headers);
      expect(res.status, scope).toBe(200);
      expect(await res.json()).toMatchObject({ toIdentityId: SECOND_ID });
    }
    expect((await call('', auth.admin())).status).toBe(200);
    expect((await call(preview(org.id), auth.admin())).status).toBe(200);
  });

  it('refuses a key without the scope', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const headers = await platformKey(['platform:groups']);
    await expectProblem(await call('', headers), 403, 'MISSING_SCOPE');
    await expectProblem(await call(preview(org.id), headers), 403, 'MISSING_SCOPE');
  });

  it('refuses an org key', async () => {
    const org = await makeOrg(kit.fx);
    const orgKey = await makeApiKey(kit.fx, { orgId: org.id, scopes: ['passes:read'] });
    await expectProblem(await call('', orgKey.headers), 403, 'PLATFORM_KEY_REQUIRED');
    await expectProblem(await call(preview(org.id), orgKey.headers), 403, 'PLATFORM_KEY_REQUIRED');
  });

  it('keeps start and arm a person’s', async () => {
    const headers = { ...(await platformKey(['platform:identities'])), 'idempotency-key': 'k1' };
    expect((await call('', headers, 'POST')).status).toBe(403);
    expect((await call('/some-move/arm', headers, 'POST')).status).toBe(403);
  });
});

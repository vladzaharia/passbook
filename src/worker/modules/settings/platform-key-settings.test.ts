// Platform-keys §3.6 tests 5 and 11: what a Platform key may do on the platform settings, the wallet release and the
// person-only routes this package declares; and how a write by a key is audited.
import { beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';

let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

async function platformKey(scopes: string[]) {
  const key = await makeApiKey(kit.fx, {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: kit.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return {
    id: key.id,
    headers: {
      ...key.headers,
      'cf-connecting-ip': '198.51.100.7',
      'content-type': 'application/json',
    },
  };
}

const call = (path: string, headers: Record<string, string>, method = 'GET', body?: unknown) =>
  app.request(
    `https://wallet.test/api/v1${path}`,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    kit.env,
  );
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

describe('platform settings by key', () => {
  it('writes a setting that does not decide sign-in, audited as the key with no org', async () => {
    const key = await platformKey(['platform:settings']);
    const res = await call('/platform/settings', key.headers, 'PUT', {
      values: { 'scan.undoWindowMinutes': 17 },
    });
    expect(res.status).toBe(200);
    const rows = await all<{ actor_type: string; actor_id: string; org_id: string | null }>(
      kit.env.DB,
      "SELECT actor_type, actor_id, org_id FROM audit_log WHERE action = 'settings.update'",
    );
    expect(rows).toEqual([{ actor_type: 'api_key', actor_id: key.id, org_id: null }]);
    expect((await call('/platform/settings', key.headers)).status).toBe(200);
  });

  it('refuses a sign-in setting, in any shape, and writes nothing', async () => {
    const key = await platformKey(['platform:settings']);
    for (const values of [
      { 'oidc.trustEmail': true },
      { 'auth.magicLinkEnabled': false },
      { 'scan.undoWindowMinutes': 17, 'auth.magicLinkEnabled': false },
      'oidc.trustEmail',
    ]) {
      const res = await call('/platform/settings', key.headers, 'PUT', { values });
      expect([res.status, await code(res)], JSON.stringify(values)).toEqual([
        403,
        'PERSON_REQUIRED',
      ]);
    }
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM audit_log WHERE actor_id = ?', [key.id]),
    ).toBeNull();
  });

  it('is read-only with platform:read, and refused another scope', async () => {
    const read = await platformKey(['platform:read']);
    expect((await call('/platform/settings', read.headers)).status).toBe(200);
    const put = await call('/platform/settings', read.headers, 'PUT', {
      values: { 'scan.undoWindowMinutes': 17 },
    });
    expect([put.status, await code(put)]).toEqual([403, 'MISSING_SCOPE']);
    const orgs = await platformKey(['platform:orgs']);
    expect((await call('/platform/settings', orgs.headers)).status).toBe(403);
  });
});

describe('wallet release by key', () => {
  it('reads the report and dry-runs enable-ready, and an apply is a person', async () => {
    const key = await platformKey(['platform:wallet']);
    const report = await call('/platform/wallet-release', key.headers);
    expect(report.status).toBe(200);
    expect(((await report.json()) as { releases: unknown[] }).releases).toHaveLength(4);
    const path = '/platform/wallet-release/google/test/enable-ready';
    for (const body of [{ apply: false }, {}])
      expect((await call(path, key.headers, 'POST', body)).status, JSON.stringify(body)).toBe(200);
    for (const body of [{ apply: true, orgIds: [] }, { apply: 'false' }, { apply: 1 }]) {
      const res = await call(path, key.headers, 'POST', body);
      expect([res.status, await code(res)], JSON.stringify(body)).toEqual([403, 'PERSON_REQUIRED']);
    }
  });

  it('is refused to a key with another platform scope', async () => {
    const key = await platformKey(['platform:users']);
    expect((await call('/platform/wallet-release', key.headers)).status).toBe(403);
  });
});

describe('person-only routes', () => {
  it('refuse a key holding every platform scope', async () => {
    const key = await platformKey([
      'platform:read',
      'platform:orgs',
      'platform:identities',
      'platform:wallet',
      'platform:settings',
    ]);
    for (const [method, path] of [
      ['POST', '/identities/wi-1/revoke-certificate'],
      ['POST', `/platform/orgs/${kit.org.id}/retention/holds/h-1/release`],
    ] as const) {
      const res = await call(path, key.headers, method, {});
      expect([res.status, await code(res)], path).toEqual([403, 'PERSON_REQUIRED']);
    }
  });

  it('still take an admin session', async () => {
    const res = await call('/platform/orgs/none/retention/holds/h-1/release', auth.admin(), 'POST');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

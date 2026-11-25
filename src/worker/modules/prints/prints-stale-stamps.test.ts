import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { releaseStamps, stampCard, stampVersion } from '../passes/stamps-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';

const ID = 'tpl-stamp-print';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let release: Awaited<ReturnType<typeof releaseStamps>>;

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  await stampVersion(kit, ID, 'v1', 10);
  release = await releaseStamps(kit, ID, 'v1');
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(
    `https://wallet.test/api/v1${path}`,
    {
      method,
      headers: { ...auth.admin(), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

describe('prints: a stamp publish', () => {
  it('leaves the printed ticket current', async () => {
    const card = await stampCard(kit, release, 2);
    expect(
      (await call('PUT', `/passes/${card.id}/channels`, { channels: { paper: 'on' } })).status,
    ).toBe(200);
    expect((await call('POST', `/passes/${card.id}/prints`)).status).toBe(200);
    const stamped = await call('POST', `/passes/${card.id}/stamps`, { action: 'add' });
    expect(stamped.status).toBe(200);
    const list = (await (await call('GET', `/passes/${card.id}/prints`)).json()) as {
      prints: { stale: boolean; passVersion: number | null }[];
    };
    expect(list.prints[0]?.passVersion).toBe(card.version);
    expect(list.prints[0]?.stale).toBe(false);
  });
});

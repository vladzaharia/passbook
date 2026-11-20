import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';
import { setupTenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  const auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const reissue = async (scopes: string[], mode: 'live' | 'test' = 'live') => {
  const key = await makeTenantTestApiKey(kit.fx, { orgId: kit.org.id, scopes, mode });
  return app.request(
    'https://wallet.test/api/v1/passes/bulk-reissue',
    {
      method: 'POST',
      headers: { ...key.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: kit.org.id, templateId: kit.template.id }),
    },
    kit.env,
  );
};

describe('POST /passes/bulk-reissue is for signed-in users only', () => {
  it('refuses every key, whatever its scope or mode', async () => {
    kit.workflow.created.length = 0;
    for (const res of [
      await reissue(['passes:write']),
      await reissue(['passes:read', 'passes:write', 'holders:write']),
      await reissue(['passes:write'], 'test'),
    ])
      expect(res.status).toBe(401);
    expect(kit.workflow.created).toHaveLength(0);
  });
});

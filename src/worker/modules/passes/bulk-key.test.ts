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

const reissue = async (
  scopes: string[],
  body: object = { orgId: kit.org.id, templateId: kit.template.id },
  orgId: string | null = kit.org.id,
) => {
  const key = await makeTenantTestApiKey(kit.fx, { orgId, scopes });
  return app.request(
    'https://wallet.test/api/v1/passes/bulk-reissue',
    {
      method: 'POST',
      headers: { ...key.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
};

describe('POST /passes/bulk-reissue takes a passes:write key in its own org', () => {
  it('starts the rebuild, with or without orgId in the body', async () => {
    for (const body of [
      { orgId: kit.org.id, templateId: kit.template.id },
      { templateId: kit.template.id },
    ]) {
      kit.workflow.created.length = 0;
      expect((await reissue(['passes:write'], body)).status).toBe(202);
      expect(kit.workflow.created).toHaveLength(1);
      expect(kit.workflow.created[0]?.params).toMatchObject({ orgId: kit.org.id });
    }
  });

  it('refuses a key without passes:write, another org, and a platform key with no org', async () => {
    kit.workflow.created.length = 0;
    const other = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
    const refused = [
      await reissue(['passes:read', 'holders:write', 'templates:read']),
      await reissue(['passes:write'], { orgId: other, templateId: kit.template.id }),
      await reissue(['passes:write'], { templateId: kit.template.id }, null),
    ];
    expect(refused.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(kit.workflow.created).toHaveLength(0);
  });
});

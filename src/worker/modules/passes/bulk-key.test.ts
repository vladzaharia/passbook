import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
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

const keyOf = async (scopes: string[], orgId: string | null = kit.org.id) =>
  (await makeTenantTestApiKey(kit.fx, { orgId, scopes })).headers;
const reissue = (headers: Record<string, string>, body: object) =>
  app.request(
    'https://wallet.test/api/v1/passes/bulk-reissue',
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );

describe('POST /passes/bulk-reissue with an API key', () => {
  it('queues a re-sign for the key org, named or implied', async () => {
    kit.workflow.created.length = 0;
    const key = await keyOf(['passes:write']);
    expect(
      (await reissue(key, { cause: 'resign', templateId: kit.template.id, orgId: kit.org.id }))
        .status,
    ).toBe(202);
    expect((await reissue(key, { cause: 'resign', templateId: kit.template.id })).status).toBe(202);
    expect(kit.workflow.created.map((c) => (c.params as { orgId: string }).orgId)).toEqual([
      kit.org.id,
      kit.org.id,
    ]);
  });

  it('refuses a key without passes:write', async () => {
    const res = await reissue(await keyOf(['passes:read']), {
      cause: 'resign',
      templateId: kit.template.id,
      orgId: kit.org.id,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MISSING_SCOPE' });
  });

  it('does not act on another org (the org check refuses), and an unbound key must name one', async () => {
    const other = await makeOrg(kit.fx);
    const key = await keyOf(['passes:write']);
    const res = await reissue(key, {
      cause: 'resign',
      templateId: kit.template.id,
      orgId: other.id,
    });
    expect(res.status).toBe(403);
    expect(
      (
        await reissue(await keyOf(['passes:write'], null), {
          cause: 'resign',
          templateId: kit.template.id,
        })
      ).status,
    ).toBe(403);
  });
});

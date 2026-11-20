import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run as run_ } from '../../platform/db.ts';
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
  it('queues a re-sign for the key org, named or implied, one run at a time', async () => {
    kit.workflow.created.length = 0;
    const key = await keyOf(['passes:write']);
    const body = { cause: 'resign', templateId: kit.template.id };
    expect((await reissue(key, { ...body, orgId: kit.org.id })).status).toBe(202);
    const [run] = kit.workflow.created;
    const busy = await reissue(key, body);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({
      code: 'BULK_RUN_ACTIVE',
      detail: expect.stringContaining(run?.id ?? 'missing'),
    });
    await run_(kit.env.DB, "UPDATE workflow_runs SET status = 'complete' WHERE instance_id = ?", [
      run?.id ?? '',
    ]);
    expect((await reissue(key, body)).status).toBe(202);
    expect(kit.workflow.created.map((c) => (c.params as { orgId: string }).orgId)).toEqual([
      kit.org.id,
      kit.org.id,
    ]);
  });

  it('keeps a test-mode key in test mode', async () => {
    kit.workflow.created.length = 0;
    const key = (
      await makeTenantTestApiKey(kit.fx, {
        orgId: kit.org.id,
        scopes: ['passes:write'],
        mode: 'test',
      })
    ).headers;
    const res = await reissue(key, { cause: 'resign', identityId: kit.fx.ids.id() });
    expect(res.status).toBe(202);
    expect(kit.workflow.created[0]?.params).toMatchObject({ mode: 'test', orgId: kit.org.id });
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

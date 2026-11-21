import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
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

/** The fake workflow never finishes a run; mark them done so the next start is not a duplicate. */
const settle = () =>
  run(kit.env.DB, "UPDATE workflow_runs SET status = 'complete', run_guard = NULL", []);

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
      await settle();
      expect((await reissue(['passes:write'], body)).status).toBe(202);
      expect(kit.workflow.created).toHaveLength(1);
      expect(kit.workflow.created[0]?.params).toMatchObject({ orgId: kit.org.id });
    }
  });

  it('refuses a key without passes:write, a second real org, and a platform key with no org', async () => {
    kit.workflow.created.length = 0;
    await settle();
    const other = await makeOrg(kit.fx, { name: 'Other Gym' });
    const refused = [
      await reissue(['passes:read', 'holders:write', 'templates:read']),
      await reissue(['passes:write'], { orgId: other.id, templateId: kit.template.id }),
      await reissue(['passes:write'], { templateId: kit.template.id }, null),
    ];
    expect(refused.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(kit.workflow.created).toHaveLength(0);
  });

  it('lets a platform passes:write key name any org, as /passes/bulk does', async () => {
    kit.workflow.created.length = 0;
    await settle();
    const res = await reissue(
      ['passes:write'],
      { orgId: kit.org.id, templateId: kit.template.id },
      null,
    );
    expect(res.status).toBe(202);
    expect(kit.workflow.created[0]?.params).toMatchObject({ orgId: kit.org.id });
  });

  it('runs a test-mode key in test mode', async () => {
    kit.workflow.created.length = 0;
    await settle();
    const pass = await kit.pass({ mode: 'test' });
    const key = await makeTenantTestApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:write'],
      mode: 'test',
    });
    const res = await app.request(
      'https://wallet.test/api/v1/passes/bulk-reissue',
      {
        method: 'POST',
        headers: { ...key.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ cause: 'resign', identityId: pass.identityId }),
      },
      kit.env,
    );
    expect(res.status).toBe(202);
    expect(kit.workflow.created[0]?.params).toMatchObject({ orgId: kit.org.id, mode: 'test' });
  });

  it('answers a second start of the same target with 409 BULK_RUN_ACTIVE and the running id', async () => {
    await settle();
    const first = await reissue(['passes:write']);
    expect(first.status).toBe(202);
    const { workflowInstanceId } = (await first.json()) as { workflowInstanceId: string };
    kit.workflow.created.length = 0;
    const second = await reissue(['passes:write']);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      code: 'BULK_RUN_ACTIVE',
      issues: [{ path: 'workflowInstanceId', message: workflowInstanceId }],
    });
    expect(kit.workflow.created).toHaveLength(0);
    await settle();
    expect((await reissue(['passes:write'])).status).toBe(202);
  });

  it('lets only one of two simultaneous starts of a target through', async () => {
    await settle();
    kit.workflow.created.length = 0;
    const [a, b] = await Promise.all([reissue(['passes:write']), reissue(['passes:write'])]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await loser.json()).toMatchObject({ code: 'BULK_RUN_ACTIVE' });
    expect(kit.workflow.created).toHaveLength(1);
  });

  it('frees the guard of a run that never finished after an hour', async () => {
    await settle();
    expect((await reissue(['passes:write'])).status).toBe(202);
    kit.clock.advance(61 * 60_000);
    expect((await reissue(['passes:write'])).status).toBe(202);
  });

  it('allows one key six starts an hour, then 429', async () => {
    const key = await makeTenantTestApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const start = async () => {
      await settle();
      return (
        await app.request(
          'https://wallet.test/api/v1/passes/bulk-reissue',
          {
            method: 'POST',
            headers: { ...key.headers, 'content-type': 'application/json' },
            body: JSON.stringify({ templateId: kit.template.id }),
          },
          kit.env,
        )
      ).status;
    };
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push(await start());
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 429]);
  });
});

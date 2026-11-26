import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { toDto } from '../operations/dto.ts';
import { progressOf } from '../operations/progress.ts';
import { rowById } from '../operations/repo.ts';
import type { ReissueParams } from './bulk-reissue-page.ts';
import { operationRunners } from './operations.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';
import { setupTenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let app: ReturnType<typeof createApp>;
let admin: () => Record<string, string>;

beforeAll(async () => {
  kit = await setupKit();
  const auth = await setupTenantTestAuth(kit);
  admin = () => auth.admin();
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const settle = () =>
  run(kit.env.DB, "UPDATE workflow_runs SET status = 'complete', run_guard = NULL", []);
const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof runBulkReissue>[3];

const start = async (scopes: string[], body: object) => {
  const key = await makeTenantTestApiKey(kit.fx, { orgId: kit.org.id, scopes });
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
const opOf = async (id: string) => toDto((await rowById(kit.env.DB, id)) as never);

describe('a rebuild shows as an operation', () => {
  it('answers operationId, and the Workflow counts the passes to Done', async () => {
    kit.workflow.created.length = 0;
    await settle();
    await kit.pass();
    const res = await start(['passes:write'], { orgId: kit.org.id, templateId: kit.template.id });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { workflowInstanceId: string; operationId: string };
    expect(body.operationId).toBeTruthy();
    const queued = await opOf(body.operationId);
    expect(queued).toMatchObject({
      kind: 'passes.reissue',
      status: 'queued',
      orgId: kit.org.id,
      mode: 'live',
      target: { type: 'reissue', id: `${kit.template.id}~~template_upgrade~` },
      startedBy: { type: 'api_key' },
    });
    const created = kit.workflow.created.find((w) => w.id === body.workflowInstanceId);
    expect(created?.params).toMatchObject({ operationId: body.operationId, operationAttempt: 1 });
    await runBulkReissue(kit.env, body.workflowInstanceId, created?.params as ReissueParams, step);
    const done = await opOf(body.operationId);
    expect(done).toMatchObject({ status: 'succeeded', text: 'Passes rebuilt' });
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(done.steps[1]?.done).not.toBeNull();
    expect(done.result?.ids).toMatchObject({ failed: '0' });
  });

  it('a retry takes the starter checks again: a read key is refused', async () => {
    kit.workflow.created.length = 0;
    await settle();
    const res = await start(['passes:write'], { orgId: kit.org.id, templateId: kit.template.id });
    const { operationId } = (await res.json()) as { operationId: string };
    const reader = await makeTenantTestApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read'],
    });
    void reader;
    const op = await opOf(operationId);
    const authorize = operationRunners['passes.reissue']?.authorizeRetry;
    await expect(
      authorize?.(kit.ctx, op, {
        kind: 'api_key',
        keyId: 'missing-key',
        orgId: kit.org.id,
        scopes: ['passes:read'],
        mode: 'live',
      } as never),
    ).rejects.toBeTruthy();
  });
});

describe('a retry runs the action that was started (M2)', () => {
  it('a re-sign by template stays a re-sign, and an explicit version stays pinned', async () => {
    kit.workflow.created.length = 0;
    await settle();
    const key = await makeTenantTestApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:write', 'passes:read'],
    });
    const post = (path: string, body: object) =>
      app.request(
        `https://wallet.test/api/v1${path}`,
        {
          method: 'POST',
          headers: { ...key.headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        kit.env,
      );
    const res = await post('/passes/bulk-reissue', {
      orgId: kit.org.id,
      templateId: kit.template.id,
      cause: 'resign',
      version: kit.template.version,
    });
    expect(res.status).toBe(202);
    const { operationId } = (await res.json()) as { operationId: string };
    await settle();
    await progressOf(kit.ctx, operationId, 1).fail(new Error('boom'));
    kit.workflow.created.length = 0;
    const retried = await post(`/operations/${operationId}/retry`, {});
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(kit.workflow.created[0]?.params).toMatchObject({
      cause: 'resign',
      templateId: kit.template.id,
      version: kit.template.version,
      operationId,
      operationAttempt: 2,
    });
  });
});

describe('a platform admin rebuild shows as a platform operation', () => {
  it('has no org, is read by an admin, and a retry needs an admin', async () => {
    kit.workflow.created.length = 0;
    await settle();
    const res = await app.request(
      'https://wallet.test/api/v1/passes/bulk-reissue',
      {
        method: 'POST',
        headers: { ...admin(), 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: kit.template.id }),
      },
      kit.env,
    );
    expect(res.status).toBe(202);
    const { operationId } = (await res.json()) as { operationId: string };
    expect(await opOf(operationId)).toMatchObject({
      kind: 'passes.reissue_platform',
      orgId: null,
      mode: null,
      target: { type: 'reissue', id: `${kit.template.id}~~template_upgrade~` },
    });
    const read = await app.request(
      `https://wallet.test/api/v1/operations/${operationId}`,
      { headers: admin() },
      kit.env,
    );
    expect(read.status).toBe(200);
    const authorize = operationRunners['passes.reissue_platform']?.authorizeRetry;
    await expect(
      authorize?.(kit.ctx, await opOf(operationId), { kind: 'session', roles: ['user'] } as never),
    ).rejects.toMatchObject({ status: 403 });
  });
});

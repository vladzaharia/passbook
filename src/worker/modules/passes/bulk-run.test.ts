import { beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { bulkInstanceId, runBulkChunk, sweepBulkRuns } from './bulk-run.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { readRun } from './repo-bulk-runs.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  for (const memberName of ['Ana A', 'Ana B', 'Ana C', 'Cy D'])
    await kit.pass({ memberName, holderEmail: 'h@example.com' });
});

const call = (method: string, path: string, body?: unknown, headers = auth.admin()) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const filter = { match: [{ input: 'memberName', op: 'startsWith', value: 'Ana' }] };
const start = (expectCount = 3, action = 'void', orgId = kit.org.id) =>
  call('POST', '/passes/bulk-runs', { action, orgId, selection: { filter, expectCount } });
type Run = {
  id: string;
  state: string;
  total: number;
  done: number;
  skipped: number;
  skippedBy: Record<string, number>;
};
const get = async (id: string) =>
  (await (await call('GET', `/passes/bulk-runs/${id}?orgId=${kit.org.id}`)).json()) as Run;
const voided = async () =>
  (
    (await (await call('GET', `/passes?orgId=${kit.org.id}&status=voided&count=true`)).json()) as {
      count: number;
    }
  ).count;

describe('bulk runs', () => {
  it('snapshots the matches after an exact count and voids only those', async () => {
    await expectProblem(await start(2), 409, 'SELECTION_CHANGED');
    await expectProblem(await start(4), 409, 'SELECTION_CHANGED');
    const res = await start(3);
    expect(res.status).toBe(202);
    const started = (await res.json()) as Run;
    expect(started).toMatchObject({ state: 'queued', total: 3 });
    expect(kit.workflow.created.at(-1)).toMatchObject({
      id: bulkInstanceId(started.id),
      params: { kind: 'bulk_action', runId: started.id },
    });
    await kit.pass({ memberName: 'Ana Late' });
    expect(await runBulkChunk(jobCtxOf(kit), started.id)).toEqual({ more: false });
    expect(await get(started.id)).toMatchObject({ state: 'done', done: 3, skipped: 0 });
    expect(await voided()).toBe(3);
  });

  it('skips a pass edited since the snapshot, and refuses a second run while one is active', async () => {
    const started = (await (await start(3)).json()) as Run;
    await expectProblem(await start(3), 409, 'BULK_RUN_ACTIVE');
    const [victim] = (
      (await (await call('GET', `/passes?orgId=${kit.org.id}&limit=5`)).json()) as {
        items: { id: string; title: string }[];
      }
    ).items.filter((p) => p.title.startsWith('Ana'));
    await call('PATCH', `/passes/${victim?.id}`, { input: { memberName: 'Ana Edited' } });
    await runBulkChunk(jobCtxOf(kit), started.id);
    const after = await get(started.id);
    expect(after).toMatchObject({
      state: 'done',
      done: 2,
      skipped: 1,
      skippedBy: { PASS_CHANGED: 1 },
    });
    // The lock is free again.
    expect((await start(3)).status).toBe(202);
  });

  it('stops after a stop request and changes nothing', async () => {
    const started = (await (await start(3)).json()) as Run;
    expect(
      (await call('POST', `/passes/bulk-runs/${started.id}/stop?orgId=${kit.org.id}`)).status,
    ).toBe(200);
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(await get(started.id)).toMatchObject({ state: 'stopped', done: 0 });
    expect(await voided()).toBe(0);
    await expectProblem(
      await call('POST', `/passes/bulk-runs/${started.id}/stop?orgId=${kit.org.id}`),
      409,
      'BULK_RUN_ENDED',
    );
  });

  it('ends failed when the starter loses access mid-run', async () => {
    const started = (await (await start(3)).json()) as Run;
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE org_id = ?', [
      kit.clock.now(),
      kit.org.id,
    ]);
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(await readRun(kit.env.DB, started.id)).toMatchObject({
      state: 'failed',
      code: 'BULK_RUN_PRINCIPAL_REVOKED',
      done: 0,
    });
  });

  it('is fenced by tenant: another org, another mode, a user without the right', async () => {
    const other = await makeOrg(kit.fx);
    expect((await start(3, 'void', other.id)).status).toBeGreaterThanOrEqual(403);
    const user = await call(
      'POST',
      '/passes/bulk-runs',
      { action: 'void', orgId: kit.org.id, selection: { filter, expectCount: 3 } },
      auth.user(),
    );
    expect(user.status).toBeGreaterThanOrEqual(403);
    const started = (await (await start(3)).json()) as Run;
    const test = await call(
      'GET',
      `/passes/bulk-runs/${started.id}?orgId=${kit.org.id}`,
      undefined,
      auth.admin({ mode: 'test' }),
    );
    expect(test.status).toBe(404);
  });

  it('frees a run that stopped moving', async () => {
    const started = (await (await start(3)).json()) as Run;
    kit.clock.advance(11 * 60_000);
    await sweepBulkRuns(jobCtxOf(kit));
    expect(await get(started.id)).toMatchObject({ state: 'failed' });
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(await voided()).toBe(0);
    expect((await start(3)).status).toBe(202);
  });

  it('removes passes through the fenced path and mails holders under the starter', async () => {
    const removed = (await (await start(3, 'remove')).json()) as Run;
    await runBulkChunk(jobCtxOf(kit), removed.id);
    expect(await get(removed.id)).toMatchObject({ state: 'done', done: 3 });
    const gone = await call('GET', `/passes?orgId=${kit.org.id}&status=removed&count=true`);
    expect(((await gone.json()) as { count: number }).count).toBe(3);
    // Mail: Cy D keeps a holder; the three removed ones are skipped as PASS_REMOVED.
    const mail = (await (
      await call('POST', '/passes/bulk-runs', {
        action: 'send_email',
        orgId: kit.org.id,
        selection: {
          filter: { match: [{ input: 'memberName', op: 'startsWith', value: 'Cy' }] },
          expectCount: 1,
        },
      })
    ).json()) as Run;
    await runBulkChunk(jobCtxOf(kit), mail.id);
    expect(await get(mail.id)).toMatchObject({ state: 'done', done: 1 });
  });

  it('refuses a remove whose starter lost access at the claim', async () => {
    const started = (await (await start(3, 'remove')).json()) as Run;
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE org_id = ?', [
      kit.clock.now(),
      kit.org.id,
    ]);
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(await readRun(kit.env.DB, started.id)).toMatchObject({ state: 'failed', done: 0 });
  });

  it('shows the current run, then none an hour after it ended', async () => {
    const none = await call('GET', `/passes/bulk-runs/current?orgId=${kit.org.id}`);
    expect(await none.json()).toEqual({});
    const started = (await (await start(3)).json()) as Run;
    const cur = async () =>
      (
        (await (await call('GET', `/passes/bulk-runs/current?orgId=${kit.org.id}`)).json()) as {
          run?: Run;
        }
      ).run;
    expect((await cur())?.id).toBe(started.id);
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect((await cur())?.state).toBe('done');
    kit.clock.advance(61 * 60_000);
    expect(await cur()).toBeUndefined();
  });
});

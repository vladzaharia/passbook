import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { bulkInstanceId, runBulkChunk, sweepBulkRuns } from './bulk-run.ts';
import { pinnedStatus } from './bulk-write.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { insertRun, readRun, saveRun } from './repo-bulk-runs.ts';
import { getPass } from './repo-read-pass.ts';
import { getPassLifecycle } from './repo-remove.ts';
import { claimRemovalTrusted } from './repo-remove-compensate.ts';
import { voidPass } from './service.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

// Faults for the replay and revocation tests: a flag makes the Nth mail throw, another makes the read proof lie.
const fault = vi.hoisted(() => ({ mailAt: 0, mails: [] as string[], proofLies: false }));
vi.mock('./pass-service-delivery.ts', async (original) => {
  const real = await original<typeof import('./pass-service-delivery.ts')>();
  return {
    ...real,
    resendEmail: async (...args: Parameters<typeof real.resendEmail>) => {
      if (fault.mailAt > 0 && fault.mails.length + 1 === fault.mailAt) {
        fault.mailAt = 0;
        throw new Error('flaky');
      }
      await real.resendEmail(...args);
      fault.mails.push(args[2]);
    },
  };
});
vi.mock('./repo-bulk-principal.ts', async (original) => {
  const real = await original<typeof import('./repo-bulk-principal.ts')>();
  return {
    ...real,
    reissuePrincipalValid: (...args: Parameters<typeof real.reissuePrincipalValid>) =>
      fault.proofLies ? Promise.resolve(true) : real.reissuePrincipalValid(...args),
  };
});

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  fault.mailAt = 0;
  fault.mails = [];
  fault.proofLies = false;
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

  it('pins a void to the snapshot version inside the write (PASS_CHANGED, pass stays active)', async () => {
    const pass = await kit.pass({ memberName: 'Pin Me' });
    const scope = { orgId: kit.org.id, mode: 'live' as const, principal: 'session' as const };
    const stale = { checks: [], version: pass.version - 1, runId: 'r' };
    await expect(
      voidPass(jobCtxOf(kit), { type: 'system', id: null }, pass.id, scope, undefined, stale),
    ).rejects.toMatchObject({ code: 'PASS_CHANGED' });
    const after = await call('GET', `/passes/${pass.id}`);
    expect(((await after.json()) as { status: string }).status).toBe('active');
    expect(pinnedStatus(undefined, 'voided')({ version: 9 })).toEqual({ status: 'voided' });
  });

  it('never mails a pass twice when a step is retried after a fault', async () => {
    const started = (await (await start(3, 'send_email')).json()) as Run;
    fault.mailAt = 3;
    await expect(runBulkChunk(jobCtxOf(kit), started.id)).rejects.toThrow('flaky');
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(fault.mails).toHaveLength(3);
    expect(new Set(fault.mails).size).toBe(3);
    expect(await get(started.id)).toMatchObject({ state: 'done', done: 3 });
  });

  it('skips email for a voided pass or one that moved since the snapshot', async () => {
    const started = (await (await start(3, 'send_email')).json()) as Run;
    const list = (await (await call('GET', `/passes?orgId=${kit.org.id}&limit=5`)).json()) as {
      items: { id: string; title: string }[];
    };
    const [a, b] = list.items.filter((p) => p.title.startsWith('Ana'));
    await call('POST', `/passes/${a?.id}/void`);
    await call('PATCH', `/passes/${b?.id}`, { input: { memberName: 'Ana Moved' } });
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(await get(started.id)).toMatchObject({
      done: 1,
      skippedBy: { NOT_ACTIVE: 1, PASS_CHANGED: 1 },
    });
  });

  it('finishes a removal that was claimed but never published', async () => {
    const [victim] = (
      (await (await call('GET', `/passes?orgId=${kit.org.id}&limit=5`)).json()) as {
        items: { id: string; title: string }[];
      }
    ).items.filter((p) => p.title.startsWith('Ana'));
    // A crash after the claim: removed_at is set, nothing was published.
    const pass = await getPass(kit.env.DB, victim?.id ?? '');
    if (!pass) throw new Error('missing');
    const lifecycle = await getPassLifecycle(kit.env.DB, pass);
    await claimRemovalTrusted(
      kit.env.DB,
      pass.id,
      { at: kit.clock.now(), message: null, priorStatus: 'active' },
      { pass, generation: lifecycle?.generation ?? 0, now: kit.clock.now() },
    );
    const started = (await (await start(3, 'remove')).json()) as Run;
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(await get(started.id)).toMatchObject({ state: 'done', done: 3 });
    const detail = (await (await call('GET', `/passes/${pass.id}`)).json()) as { status: string };
    expect(detail.status).toBe('voided');
  });

  for (const action of ['void', 'remove', 'send_email'] as const)
    it(`refuses a ${action} write when the starter is revoked between the read proof and the write`, async () => {
      const started = (await (await start(3, action)).json()) as Run;
      await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE org_id = ?', [
        kit.clock.now(),
        kit.org.id,
      ]);
      fault.proofLies = true;
      await runBulkChunk(jobCtxOf(kit), started.id);
      expect((await readRun(kit.env.DB, started.id))?.done).toBe(0);
      expect(fault.mails).toHaveLength(0);
      const count = await first<{ n: number }>(
        kit.env.DB,
        "SELECT COUNT(*) AS n FROM passes WHERE org_id = ? AND (status = 'voided' OR removed_at IS NOT NULL)",
        [kit.org.id],
      );
      expect(count?.n).toBe(0);
    });

  it('is not starved by ended runs, and a run that lost its lock stops', async () => {
    const stalled = (await (await start(3)).json()) as Run;
    const rec = await readRun(kit.env.DB, stalled.id);
    if (!rec) throw new Error('missing');
    for (let i = 0; i < 55; i++) {
      const ended = { ...rec, id: `ended${i}`, createdAt: 1, updatedAt: 1 };
      await insertRun(kit.env.DB, ended);
      await saveRun(kit.env.DB, { ...ended, state: 'done', finishedAt: 2, updatedAt: 2 });
    }
    kit.clock.advance(11 * 60_000);
    await sweepBulkRuns(jobCtxOf(kit));
    expect(await get(stalled.id)).toMatchObject({ state: 'failed' });
    // Another run holds the lock now: the old one does not go on beside it.
    const next = (await (await start(3)).json()) as Run;
    await run(kit.env.DB, "UPDATE pass_bulk_locks SET run_id = 'other' WHERE org_id = ?", [
      kit.org.id,
    ]);
    await runBulkChunk(jobCtxOf(kit), next.id);
    expect(await readRun(kit.env.DB, next.id)).toMatchObject({
      state: 'failed',
      code: 'BULK_RUN_SUPERSEDED',
    });
  });

  it('answers the first run to a repeated Idempotency-Key', async () => {
    const body = { action: 'send_email', orgId: kit.org.id, selection: { filter, expectCount: 3 } };
    const send = () =>
      call('POST', '/passes/bulk-runs', body, { ...auth.admin(), 'idempotency-key': 'k1' });
    const first = (await (await send()).json()) as Run;
    const again = (await (await send()).json()) as Run;
    expect(again.id).toBe(first.id);
  });

  it('ends a run whose page is short as lost', async () => {
    const started = (await (await start(3)).json()) as Run;
    await kit.env.BUCKET.put(`bulk-runs/${kit.org.id}/${started.id}/0.json`, '[]');
    await runBulkChunk(jobCtxOf(kit), started.id);
    expect(await readRun(kit.env.DB, started.id)).toMatchObject({
      state: 'failed',
      code: 'BULK_RUN_LOST',
    });
  });
});

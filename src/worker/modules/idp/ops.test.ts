import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import {
  admin,
  f,
  installOpsRig,
  opOf,
  paused,
  read,
  rig,
  runNext,
  start,
} from './ops-test-fixtures.ts';
import { SYNC_LEASE, takeLease } from './repo-lease.ts';

installOpsRig();

describe('access', () => {
  it('is for platform admins signed in with Polaris ID', async () => {
    const p = await paused();
    const routes: [string, string][] = [
      ['POST', '/api/v1/platform/idp/reconcile'],
      ['POST', '/api/v1/platform/idp/scim-breaker/clear'],
      ['DELETE', `/api/v1/users/${p.user.id}/holds/console`],
    ];
    const key = await makeApiKey(f());
    for (const [method, path] of routes) {
      expect((await start(path, method, {})).status).toBe(401);
      expect((await start(path, method, key.headers)).status).toBe(401);
      await expectProblem(
        await start(path, method, (await admin(['user'])).headers),
        403,
        'FORBIDDEN',
      );
      await expectProblem(
        await start(path, method, (await admin(['admin', 'user'], 'magic_link')).headers),
        403,
        'IDP_SIGN_IN_REQUIRED',
      );
    }
    expect(rig.queue.jobs).toEqual([]);
  });

  it('asks an old sign-in to prove itself again', async () => {
    const user = await makeUser(f());
    const old = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      authTime: rig.h.clock.now() - 3 * 3600_000,
    });
    await expectProblem(
      await start('/api/v1/platform/idp/reconcile', 'POST', old.headers, {}),
      403,
      'STEP_UP_REQUIRED',
    );
  });

  it('keeps the operation from everyone but platform admins', async () => {
    const a = await admin();
    const op = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers, {}));
    const other = await admin(['user']);
    expect(
      (await rig.h.call(`/api/v1/operations/${op.id}`, { headers: other.headers })).status,
    ).toBe(404);
    const key = await makeApiKey(f());
    expect((await rig.h.call(`/api/v1/operations/${op.id}`, { headers: key.headers })).status).toBe(
      404,
    );
    expect((await rig.h.call(`/api/v1/operations/${op.id}`, { headers: a.headers })).status).toBe(
      200,
    );
  });
});

describe('check now and dry run', () => {
  it('answers 202 with the operation and runs it step by step', async () => {
    const a = await admin();
    const res = await start('/api/v1/platform/idp/reconcile', 'POST', a.headers);
    expect(res.status).toBe(202);
    const op = await opOf(res);
    expect(res.headers.get('location')).toBe(`/api/v1/operations/${op.id}`);
    expect(op).toMatchObject({ kind: 'idp.check', status: 'queued', cancelable: false });
    expect(rig.queue.jobs).toMatchObject([{ kind: 'operation.run', operationId: op.id }]);
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done']);
    expect(done.result?.ids).toMatchObject({ dryRun: 'no', capped: 'no' });
  });

  it('a dry run sends no write and records no hold', async () => {
    const a = await admin();
    const op = await opOf(
      await start('/api/v1/platform/idp/reconcile', 'POST', a.headers, { dryRun: true }),
    );
    expect(op.kind).toBe('idp.dry_run');
    const writes = rig.idp.writes;
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.status).toBe('succeeded');
    expect(done.result?.ids.dryRun).toBe('yes');
    expect(rig.idp.writes).toBe(writes);
  });

  it('one run at a time: a second start names the first', async () => {
    const a = await admin();
    const first1 = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers));
    const res = await start('/api/v1/platform/idp/reconcile', 'POST', a.headers, { dryRun: true });
    await expectProblem(res, 409, 'OPERATION_RUNNING');
    expect(((await res.clone().json()) as { operationId?: string }).operationId).toBe(first1.id);
  });

  it('waits while the sync lease is taken, and gives up after ten minutes', async () => {
    const a = await admin();
    const op = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers));
    await takeLease(rig.h.env.DB, SYNC_LEASE, 'other-run', rig.h.clock.now());
    await runNext(op);
    const waiting = await read(op.id, a.headers);
    expect(waiting.status).toBe('waiting');
    expect(waiting.steps[0]).toMatchObject({ key: 'connect', state: 'waiting' });
    expect(rig.queue.jobs.at(-1)).toMatchObject({ kind: 'operation.run', delayed: true });
    rig.h.clock.advance(11 * 60_000);
    await run(rig.h.env.DB, 'UPDATE idp_run_lease SET expires_at = ?', [
      rig.h.clock.now() + 600_000,
    ]);
    await runNext(op);
    const failed = await read(op.id, a.headers);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'IDP_SYNC_BUSY', retryable: true });
  });

  it('fails when Polaris ID is frozen, and a retry needs a Polaris ID admin', async () => {
    const a = await admin();
    rig.idp.frozen = true;
    const op = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers));
    await runNext(op);
    const failed = await read(op.id, a.headers);
    expect(failed.error).toMatchObject({ code: 'IDP_NOT_READY', step: 'connect' });
    const weak = await admin(['admin', 'user'], 'magic_link');
    expect(
      (await start(`/api/v1/operations/${op.id}/retry`, 'POST', weak.headers)).status,
    ).toBeGreaterThanOrEqual(400);
    rig.idp.frozen = false;
    const retried = await start(`/api/v1/operations/${op.id}/retry`, 'POST', a.headers);
    expect(retried.status).toBe(200);
    await runNext({ ...op, attempt: 2 });
    expect((await read(op.id, a.headers)).status).toBe('succeeded');
  });

  it('fails when the admin who started it lost the role before it ran', async () => {
    const a = await admin();
    const op = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers));
    // The real path: SCIM ends the demoted admin's sessions; `last_roles` still names admin.
    await run(rig.h.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
      rig.h.clock.now(),
      a.user.id,
    ]);
    await runNext(op);
    expect((await read(op.id, (await admin()).headers)).error?.code).toBe('IDP_ADMIN_ENDED');
  });
});

describe('snapshot budget', () => {
  const low = (left: number) => {
    const health = rig.idp.health.bind(rig.idp);
    rig.idp.health = async () => ({
      ...(await health()),
      budget: { snapshot: { day: 30 - left, limit: 30 } },
    });
  };

  it('keeps the daily reconcile its share', async () => {
    low(4);
    const a = await admin();
    const op = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers));
    await runNext(op);
    expect((await read(op.id, a.headers)).error?.code).toBe('IDP_BUDGET_LOW');
  });

  it('reports what is left', async () => {
    low(20);
    const a = await admin();
    const op = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers));
    await runNext(op);
    expect((await read(op.id, a.headers)).result?.ids.snapshotsLeft).toBe('19');
  });

  it('a retry gets a fresh ten minutes of waiting', async () => {
    const a = await admin();
    const op = await opOf(await start('/api/v1/platform/idp/reconcile', 'POST', a.headers));
    await takeLease(rig.h.env.DB, SYNC_LEASE, 'other-run', rig.h.clock.now());
    await runNext(op);
    rig.h.clock.advance(11 * 60_000);
    await run(rig.h.env.DB, 'UPDATE idp_run_lease SET expires_at = ?', [
      rig.h.clock.now() + 600_000,
    ]);
    await runNext(op);
    // The clock moved on: another admin, with a recent sign-in, reads and retries.
    const b = await admin();
    expect((await read(op.id, b.headers)).error?.code).toBe('IDP_SYNC_BUSY');
    expect((await start(`/api/v1/operations/${op.id}/retry`, 'POST', b.headers)).status).toBe(200);
    await run(rig.h.env.DB, 'UPDATE idp_run_lease SET expires_at = ?', [
      rig.h.clock.now() + 600_000,
    ]);
    await runNext({ ...op, attempt: 2 });
    expect((await read(op.id, b.headers)).status).toBe('waiting');
  });
});

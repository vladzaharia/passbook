import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { type OperationDto, OperationResultSchema } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { AppError, toProblem } from '../../platform/errors.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { toDto } from './dto.ts';
import { handleOperationRun } from './jobs.ts';
import {
  NEVER_KIND,
  ORG_KIND,
  PLATFORM_KIND,
  person,
  QUEUED_ONLY_KIND,
  registerTestKinds,
  STARTER_KIND,
  STEP_UP_KIND,
} from './operations-test-fixtures.ts';
import { progressOf } from './progress.ts';
import type { OperationRunner } from './registry.ts';
import { rowById } from './repo.ts';
import { sweepStalledOperations } from './stalls.ts';
import { operationIdFor, startOperation } from './start.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let undo: () => void;
const base: OperationRunner = {
  run: vi.fn(async () => {}),
  authorizeRetry: async () => {},
};

beforeEach(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  undo = registerTestKinds(base);
});
afterEach(() => undo());

const post = (path: string, headers: Record<string, string>) =>
  app.request(
    `${ORIGIN}/api/v1/operations${path}`,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' },
    kit.env,
  );
const get = (path: string, headers: Record<string, string>) =>
  app.request(`${ORIGIN}/api/v1/operations${path}`, { headers }, kit.env);
const start = (extra: Partial<Parameters<typeof startOperation>[1]> = {}) =>
  startOperation(kit.ctx, {
    kind: ORG_KIND.kind,
    org: { orgId: kit.org.id, mode: 'live' },
    actor: { type: 'user', id: 'u1' },
    subject: { k: kit.ctx.ids.id() },
    ...extra,
  });
const read = async (id: string) => toDto((await rowById(kit.env.DB, id)) as never);
const count = async (action: string, id: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target_id = ?',
      [action, id],
    )
  )?.n;

describe('stall sweep and Workflows (M1)', () => {
  const withWorkflow = (status: () => Promise<{ status: string }>) => {
    undo();
    undo = registerTestKinds({ ...base, workflow: async () => ({ status }) });
  };
  const wfOp = async () => {
    const op = await start();
    await run(kit.env.DB, "UPDATE operations SET workflow_instance_id = 'wf' WHERE id = ?", [
      op.id,
    ]);
    await progressOf(kit.ctx, op.id, 1).step('a').done();
    kit.clock.advance(300_000);
    return op;
  };

  it('never fails a running row on an unclassified error', async () => {
    withWorkflow(async () => {
      throw new Error('binding timed out');
    });
    const op = await wfOp();
    await sweepStalledOperations(kit.ctx);
    expect((await read(op.id)).status).toBe('running');
  });

  it('fails only a definite not-found', async () => {
    withWorkflow(async () => {
      throw new Error('instance.not_found');
    });
    const op = await wfOp();
    await sweepStalledOperations(kit.ctx);
    expect((await read(op.id)).error?.code).toBe('OPERATION_STALLED');
  });

  it('does not assume a completed Workflow succeeded: its lost outcome is unknown and retryable', async () => {
    withWorkflow(async () => ({ status: 'complete' }));
    const op = await wfOp();
    await sweepStalledOperations(kit.ctx);
    expect((await read(op.id)).error).toMatchObject({
      code: 'OPERATION_OUTCOME_UNKNOWN',
      retryable: true,
    });
  });
});

describe('queued rows (M2)', () => {
  it('resends a start that never ran once, then fails it and frees the dedupe key', async () => {
    const op = await start({ subject: { k: 'q' } });
    kit.clock.advance(300_000);
    await sweepStalledOperations(kit.ctx);
    expect(kit.queue.sent).toContainEqual({
      kind: 'operation.run',
      operationId: op.id,
      attempt: 1,
    });
    expect((await read(op.id)).status).toBe('queued');
    kit.clock.advance(300_000);
    await sweepStalledOperations(kit.ctx);
    const failed = await read(op.id);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'OPERATION_STALLED' } });
    expect(failed.steps.map((s) => s.state)).toEqual(['failed', 'pending', 'pending']);
    await expect(start({ subject: { k: 'q' } })).resolves.toMatchObject({ status: 'queued' });
  });

  it('gives each resend one claimant: a second job finds the lease owned', async () => {
    const op = await start();
    const job = { kind: 'operation.run', operationId: op.id, attempt: 1 } as const;
    await handleOperationRun(job, kit.ctx);
    await handleOperationRun(job, kit.ctx);
    expect(base.run).toHaveBeenCalledOnce();
  });
});

describe('lease owner (L5)', () => {
  it('refuses writes of a runner that does not hold the claimed lease', async () => {
    const op = await start();
    await run(kit.env.DB, "UPDATE operations SET lease_owner = 'a', lease_until = ? WHERE id = ?", [
      kit.clock.now() + 60_000,
      op.id,
    ]);
    await progressOf(kit.ctx, op.id, 1, 'b').step('a').done();
    expect((await read(op.id)).steps[0]?.state).toBe('pending');
    await progressOf(kit.ctx, op.id, 1, 'a').step('a').done();
    expect((await read(op.id)).steps[0]?.state).toBe('done');
  });
});

describe('result href (M4)', () => {
  it.each([
    '/\\evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '//evil.com',
    'https://evil.com',
    'javascript:1',
  ])('refuses %j', (href) => {
    expect(OperationResultSchema.safeParse({ href, ids: {} }).success).toBe(false);
  });

  it('accepts an app path, drops a bad one on write, and bounds ids', async () => {
    expect(
      OperationResultSchema.safeParse({ href: '/admin/passes?x=1', ids: { passId: 'a-1' } })
        .success,
    ).toBe(true);
    expect(OperationResultSchema.safeParse({ href: null, ids: { note: 'a@b.c' } }).success).toBe(
      false,
    );
    const op = await start();
    await progressOf(kit.ctx, op.id, 1).succeed({ href: '/\\evil.com', ids: {} });
    expect(await read(op.id)).toMatchObject({ status: 'succeeded', result: null });
  });
});

describe('cancel is atomic (M5)', () => {
  it('does not stop a started row of a queued-only kind, and leaves no audit row', async () => {
    const op = await start({ kind: QUEUED_ONLY_KIND.kind });
    await run(kit.env.DB, "UPDATE operations SET status = 'running' WHERE id = ?", [op.id]);
    const res = await post(`/${op.id}/cancel`, auth.admin());
    expect(res.status).toBe(409);
    expect(await read(op.id)).toMatchObject({ status: 'running', cancelRequested: false });
    expect(await count('operation.cancelled', op.id)).toBe(0);
  });

  it('never stops a never-kind and audits nothing', async () => {
    const op = await start({ kind: NEVER_KIND.kind });
    expect((await post(`/${op.id}/cancel`, auth.admin())).status).toBe(409);
    expect(await count('operation.cancelled', op.id)).toBe(0);
  });

  it('audits one real stop only', async () => {
    const op = await start();
    await post(`/${op.id}/cancel`, auth.admin());
    expect(await count('operation.cancelled', op.id)).toBe(1);
    await post(`/${op.id}/cancel`, auth.admin());
    expect(await count('operation.cancelled', op.id)).toBe(1);
  });
});

describe('caller-chosen ids (M6)', () => {
  it('answers the same request, and refuses another caller of the same id', async () => {
    const first = await start({ id: 'shared-id' });
    await expect(start({ id: 'shared-id' })).resolves.toMatchObject({ id: first.id });
    const other = await start({ id: 'shared-id', actor: { type: 'user', id: 'u2' } }).catch(
      (e) => e,
    );
    expect(toProblem(other)).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    const otherOrg = await makeOrg(kit.fx, { name: 'Other' });
    const crossOrg = await start({
      id: 'shared-id',
      org: { orgId: otherOrg.id, mode: 'live' },
    }).catch((e) => e);
    expect(crossOrg).toBeInstanceOf(AppError);
  });

  it('derives ids per principal and kind', async () => {
    const a = await operationIdFor('session:u1', 'k', 'key');
    expect(a).toBe(await operationIdFor('session:u1', 'k', 'key'));
    expect(a).not.toBe(await operationIdFor('session:u2', 'k', 'key'));
    expect(a).toHaveLength(32);
  });
});

describe('dedupe keys (L2)', () => {
  it('do not collide across orgs, and a 409 names the operation only to its own starter', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other' });
    const mine = await start({ subject: { k: 'same' } });
    await expect(
      start({ subject: { k: 'same' }, org: { orgId: other.id, mode: 'live' } }),
    ).resolves.toMatchObject({ status: 'queued' });
    const own = await start({ subject: { k: 'same' } }).catch((e) => e);
    expect(toProblem(own)).toMatchObject({ code: 'OPERATION_RUNNING', operationId: mine.id });
    const stranger = await start({
      subject: { k: 'same' },
      actor: { type: 'user', id: 'u9' },
    }).catch((e) => e);
    expect(toProblem(stranger).operationId).toBeUndefined();
  });
});

describe('step-up reveals nothing (L1)', () => {
  it('answers 404 to a stale session that cannot act on the operation', async () => {
    const op = await start({ kind: STEP_UP_KIND.kind });
    const stale = await person(kit, undefined, ['user'], kit.clock.now() - 3_600_000);
    expect((await post(`/${op.id}/cancel`, stale.headers)).status).toBe(404);
    expect((await post('/no-such-id/cancel', stale.headers)).status).toBe(404);
  });
});

describe('retry replay (L3)', () => {
  it('answers both of two concurrent retries with the same key', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, 1);
    p.step('a');
    await p.fail(new AppError('X_FAILED', 500, 'x'));
    const headers = { ...auth.admin(), 'idempotency-key': 'same' };
    const [one, two] = await Promise.all([
      post(`/${op.id}/retry`, headers),
      post(`/${op.id}/retry`, headers),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(((await two.json()) as OperationDto).attempt).toBe(2);
  });
});

describe('starter rows (L7, L8)', () => {
  it('may be stopped by any live, strong session of the person; a weak session cannot', async () => {
    const owner = await person(kit);
    const second = await makeSecondSession(owner.userId, 'oidc');
    const hash = (
      await first<{ id_hash: string }>(
        kit.env.DB,
        'SELECT id_hash FROM sessions WHERE user_id = ? ORDER BY created_at LIMIT 1',
        [owner.userId],
      )
    )?.id_hash;
    const op = await startOperation(kit.ctx, {
      kind: STARTER_KIND.kind,
      actor: { type: 'user', id: owner.userId },
      session: hash ?? 'sess',
    });
    expect((await get(`/${op.id}`, second)).status).toBe(200);
    const weak = await makeSecondSession(owner.userId, 'magic_link');
    expect((await post(`/${op.id}/cancel`, weak)).status).toBe(403);
    const stop = await post(`/${op.id}/cancel`, second);
    expect(stop.status, await stop.clone().text()).toBe(200);
  });

  it('keeps 7 days from a retry', async () => {
    const owner = await person(kit);
    const hash = (
      await first<{ id_hash: string }>(
        kit.env.DB,
        'SELECT id_hash FROM sessions WHERE user_id = ?',
        [owner.userId],
      )
    )?.id_hash as string;
    const op = await startOperation(kit.ctx, {
      kind: STARTER_KIND.kind,
      actor: { type: 'user', id: owner.userId },
      session: hash,
    });
    await progressOf(kit.ctx, op.id, 1).fail(new AppError('X_FAILED', 500, 'x'));
    kit.clock.advance(1_000_000);
    expect((await post(`/${op.id}/retry`, owner.headers)).status).toBe(200);
    expect((await rowById(kit.env.DB, op.id))?.expires_at).toBe(kit.clock.now() + 7 * 86_400_000);
  });
});

async function makeSecondSession(
  userId: string,
  amr?: 'magic_link' | 'oidc',
): Promise<Record<string, string>> {
  const { makeSession } = await import('../../../../test/helpers/index.ts');
  const s = await makeSession(kit.fx, { userId, ...(amr ? { amr } : {}) });
  return { ...s.headers, origin: ORIGIN };
}

describe('verify round', () => {
  it('V1: after a retry the sweep checks the new Workflow instance, not the dead one', async () => {
    const seen: string[] = [];
    undo();
    undo = registerTestKinds({
      ...base,
      workflow: async (_ctx, instanceId) => ({
        status: async () => {
          seen.push(instanceId);
          return { status: instanceId === 'wf' ? 'errored' : 'running' };
        },
      }),
      relaunch: async () => ({ workflowInstanceId: 'wf-r2' }),
    });
    const op = await start({ workflowInstanceId: 'wf' });
    const p = progressOf(kit.ctx, op.id, 1);
    p.step('a');
    await p.fail(new AppError('X_FAILED', 500, 'x'));
    expect((await post(`/${op.id}/retry`, auth.admin())).status).toBe(200);
    expect((await rowById(kit.env.DB, op.id))?.workflow_instance_id).toBe('wf-r2');
    await progressOf(kit.ctx, op.id, 2).step('a').done();
    kit.clock.advance(300_000);
    await sweepStalledOperations(kit.ctx);
    expect(seen).toEqual(['wf-r2']);
    expect((await read(op.id)).status).toBe('running');
  });

  it('V2: a queued-only stop cannot take a row a runner already leased', async () => {
    const op = await start({ kind: QUEUED_ONLY_KIND.kind });
    await handleOperationRun({ kind: 'operation.run', operationId: op.id, attempt: 1 }, kit.ctx);
    expect((await post(`/${op.id}/cancel`, auth.admin())).status).toBe(409);
    expect((await read(op.id)).status).toBe('queued');
    expect(await count('operation.cancelled', op.id)).toBe(0);
  });

  it('V3: a starter start without a session is refused', async () => {
    const error = await startOperation(kit.ctx, {
      kind: STARTER_KIND.kind,
      actor: { type: 'user', id: 'u1' },
    }).catch((e) => e);
    expect((error as AppError).code).toBe('OPERATION_SESSION_REQUIRED');
  });

  it('V4: a runner that lost its lease cannot end the row', async () => {
    const op = await start();
    await run(kit.env.DB, "UPDATE operations SET lease_owner = 'a', lease_until = ? WHERE id = ?", [
      kit.clock.now() + 60_000,
      op.id,
    ]);
    await progressOf(kit.ctx, op.id, 1, 'b').succeed();
    expect((await read(op.id)).status).toBe('queued');
    await progressOf(kit.ctx, op.id, 1, 'a').succeed();
    expect((await read(op.id)).status).toBe('succeeded');
  });

  it('V5: a retry 409 names the operation only to the caller who started it', async () => {
    const op = await start({ subject: { k: 'v5' }, actor: { type: 'user', id: 'someone-else' } });
    await progressOf(kit.ctx, op.id, 1).fail(new AppError('X_FAILED', 500, 'x'));
    const twin = await start({ subject: { k: 'v5' }, actor: { type: 'user', id: 'someone-else' } });
    const res = await post(`/${op.id}/retry`, auth.admin());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { operationId?: string }).operationId).toBeUndefined();
    expect(twin.id).not.toBe(op.id);
  });

  it('V6: the retention sweep drains more than one batch', async () => {
    await run(
      kit.env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
       INSERT INTO operations (id, kind, audience, steps, status, actor_type, created_at, updated_at, expires_at)
       SELECT 'old-' || i, 'test.org', 'platform', '[]', 'succeeded', 'system', 1, 1, 2 FROM n`,
    );
    const { sweepOperations } = await import('./sweep.ts');
    await sweepOperations(kit.ctx);
    const left = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM operations WHERE id LIKE 'old-%'",
    );
    expect(left?.n ?? 0).toBe(0);
  });

  it('V7: a platform kind has one active run for every admin', async () => {
    const a = await startOperation(kit.ctx, {
      kind: PLATFORM_KIND.kind,
      actor: { type: 'user', id: 'a1' },
      subject: { s: 'x' },
    });
    const error = await startOperation(kit.ctx, {
      kind: PLATFORM_KIND.kind,
      actor: { type: 'user', id: 'a2' },
      subject: { s: 'x' },
    }).catch((e) => e);
    expect(toProblem(error).code).toBe('OPERATION_RUNNING');
    expect(a.status).toBe('queued');
  });
});

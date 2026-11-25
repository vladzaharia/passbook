import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { toDto } from './dto.ts';
import { handleOperationRun, runInRequest } from './jobs.ts';
import {
  NEVER_KIND,
  ORG_KIND,
  person,
  QUEUED_ONLY_KIND,
  registerTestKinds,
  STEP_UP_KIND,
} from './operations-test-fixtures.ts';
import { progressOf } from './progress.ts';
import type { OperationRunner } from './registry.ts';
import { rowById } from './repo.ts';
import { sweepStalledOperations } from './stalls.ts';
import { startOperation } from './start.ts';
import { sweepOperations } from './sweep.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let undo: () => void;
const mocks = {
  run: vi.fn<NonNullable<OperationRunner['run']>>(async () => {}),
  retry: vi.fn<NonNullable<OperationRunner['retry']>>(async () => {}),
  cancel: vi.fn<NonNullable<OperationRunner['cancel']>>(async () => {}),
};
const runner: OperationRunner = mocks;

beforeEach(async () => {
  vi.clearAllMocks();
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  undo = registerTestKinds(runner);
});
afterEach(() => undo());

const post = (path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1/operations${path}`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    kit.env,
  );
const start = (kind: string = ORG_KIND.kind, k = kit.ctx.ids.id()) =>
  startOperation(kit.ctx, {
    kind,
    org: { orgId: kit.org.id, mode: 'live' },
    actor: { type: 'user', id: 'u1' },
    subject: { k },
  });
const read = async (id: string) => toDto((await rowById(kit.env.DB, id)) as never);
const failed = async (kind?: string) => {
  const op = await start(kind);
  const p = progressOf(kit.ctx, op.id, 1);
  await p.step('a').done();
  p.step('b');
  await p.fail(new AppError('X_FAILED', 500, 'x'));
  return op;
};

describe('cancel', () => {
  it('stops a queued operation at once and audits it', async () => {
    const op = await start();
    const res = await post(`/${op.id}/cancel`, auth.admin());
    expect(res.status).toBe(200);
    const stopped = (await res.json()) as OperationDto;
    expect(stopped).toMatchObject({ status: 'cancelled', text: 'Stopped' });
    expect(stopped.steps.every((s) => s.state === 'skipped')).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledOnce();
    const audit = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'operation.cancelled' AND target_id = ?",
      [op.id],
    );
    expect(audit?.n).toBe(1);
  });

  it('marks a running operation and answers a repeat with the same one', async () => {
    const op = await start();
    await progressOf(kit.ctx, op.id, 1).step('a').done();
    const res = await post(`/${op.id}/cancel`, auth.admin());
    expect(await res.json()).toMatchObject({
      status: 'running',
      cancelRequested: true,
      cancelable: false,
    });
    expect((await post(`/${op.id}/cancel`, auth.admin())).status).toBe(200);
  });

  it('refuses what the policy forbids with 409 OPERATION_NOT_CANCELABLE', async () => {
    const never = await start(NEVER_KIND.kind);
    const res = await post(`/${never.id}/cancel`, auth.admin());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OPERATION_NOT_CANCELABLE' });
    const queued = await start(QUEUED_ONLY_KIND.kind);
    await progressOf(kit.ctx, queued.id, 1).step('a').done();
    expect((await post(`/${queued.id}/cancel`, auth.admin())).status).toBe(409);
    const ended = await start();
    await progressOf(kit.ctx, ended.id, 1).succeed();
    expect((await post(`/${ended.id}/cancel`, auth.admin())).status).toBe(409);
  });

  it('needs the write capability: a reader can see it but not stop it', async () => {
    const op = await start();
    const reader = await person(kit, ['read_only']);
    expect((await post(`/${op.id}/cancel`, reader.headers)).status).toBe(403);
    const outsider = await person(kit);
    expect((await post(`/${op.id}/cancel`, outsider.headers)).status).toBe(404);
  });

  it('asks a session for a recent sign-in when the kind needs one', async () => {
    const op = await start(STEP_UP_KIND.kind);
    const stale = await person(kit, ['org_admin'], ['user'], kit.clock.now() - 3_600_000);
    const res = await post(`/${op.id}/cancel`, stale.headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await post(`/${op.id}/cancel`, auth.admin())).status).toBe(200);
  });
});

describe('retry', () => {
  it('reruns a failed operation under the same id with the next attempt', async () => {
    const op = await failed();
    const res = await post(`/${op.id}/retry`, { ...auth.admin(), 'idempotency-key': 'k1' });
    expect(res.status).toBe(200);
    const next = (await res.json()) as OperationDto;
    expect(next).toMatchObject({ id: op.id, attempt: 2, status: 'queued', error: null });
    expect(next.steps.map((s) => s.state)).toEqual(['done', 'pending', 'pending']);
    expect(mocks.retry).toHaveBeenCalledOnce();
    // The same key again answers the retried operation and runs nothing.
    const replay = await post(`/${op.id}/retry`, { ...auth.admin(), 'idempotency-key': 'k1' });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as OperationDto).attempt).toBe(2);
    expect(mocks.retry).toHaveBeenCalledOnce();
    // Another key is another request: the operation has not failed again, so it is refused.
    const other = await post(`/${op.id}/retry`, { ...auth.admin(), 'idempotency-key': 'k2' });
    expect(other.status).toBe(409);
  });

  it('refuses an operation that has not failed with 409 OPERATION_NOT_RETRYABLE', async () => {
    const op = await start();
    const res = await post(`/${op.id}/retry`, auth.admin());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OPERATION_NOT_RETRYABLE' });
  });

  it('ends as a failure again when the kind retry checks refuse', async () => {
    const op = await failed();
    mocks.retry.mockRejectedValueOnce(new AppError('FEATURE_NOT_INCLUDED', 403, 'no'));
    const res = await post(`/${op.id}/retry`, auth.admin());
    expect(res.status).toBe(403);
    expect(await read(op.id)).toMatchObject({
      status: 'failed',
      attempt: 2,
      error: { code: 'FEATURE_NOT_INCLUDED' },
    });
  });

  it('answers OPERATION_RUNNING when another is active for the subject', async () => {
    const op = await failed();
    await start(ORG_KIND.kind, 'k-reuse');
    await run(kit.env.DB, "UPDATE operations SET dedupe_key = 'test:k-reuse' WHERE id = ?", [
      op.id,
    ]);
    const res = await post(`/${op.id}/retry`, auth.admin());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OPERATION_RUNNING' });
  });
});

describe('operation.run', () => {
  it('runs the hook once, and skips an ended operation, an old attempt and a fresh lease', async () => {
    const op = await start();
    const job = { kind: 'operation.run', operationId: op.id, attempt: 1 } as const;
    await handleOperationRun(job, kit.ctx);
    expect(mocks.run).toHaveBeenCalledOnce();
    await handleOperationRun(job, kit.ctx);
    expect(mocks.run).toHaveBeenCalledOnce();
    await handleOperationRun({ ...job, attempt: 2 }, kit.ctx);
    kit.clock.advance(120_000);
    await progressOf(kit.ctx, op.id, 1).succeed();
    await handleOperationRun(job, kit.ctx);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('fails the operation when the hook throws', async () => {
    const op = await start();
    mocks.run.mockRejectedValueOnce(new Error('boom'));
    await handleOperationRun({ kind: 'operation.run', operationId: op.id, attempt: 1 }, kit.ctx);
    expect((await read(op.id)).error?.code).toBe('OPERATION_FAILED');
  });

  it('runs in the request with a delayed backstop that a live lease leaves alone', async () => {
    const op = await startOperation(kit.ctx, {
      kind: ORG_KIND.kind,
      org: { orgId: kit.org.id, mode: 'live' },
      actor: { type: 'user', id: 'u1' },
      subject: { k: 'req' },
      lease: true,
    });
    const work = vi.fn(async () => {});
    await runInRequest(kit.ctx, op.id, 1, work);
    await kit.settle();
    expect(work).toHaveBeenCalledOnce();
    expect(kit.queue.sent).toContainEqual({
      kind: 'operation.run',
      operationId: op.id,
      attempt: 1,
    });
    await handleOperationRun({ kind: 'operation.run', operationId: op.id, attempt: 1 }, kit.ctx);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe('stall sweep', () => {
  const dead = (status: string) =>
    registerTestKinds({
      ...runner,
      workflow: async () => ({ status: async () => ({ status }) }),
    });

  it('fails a row whose Workflow errored, as OPERATION_STALLED at its step', async () => {
    undo();
    undo = dead('errored');
    const op = await start();
    await run(kit.env.DB, "UPDATE operations SET workflow_instance_id = 'wf-1' WHERE id = ?", [
      op.id,
    ]);
    await progressOf(kit.ctx, op.id, 1).step('b').count(1);
    kit.clock.advance(300_000);
    await sweepStalledOperations(kit.ctx);
    expect(await read(op.id)).toMatchObject({
      status: 'failed',
      step: 'b',
      error: { code: 'OPERATION_STALLED', retryable: true },
    });
  });

  it('only bumps the heartbeat of a Workflow that is still running', async () => {
    undo();
    undo = dead('running');
    const op = await start();
    await run(kit.env.DB, "UPDATE operations SET workflow_instance_id = 'wf-1' WHERE id = ?", [
      op.id,
    ]);
    await progressOf(kit.ctx, op.id, 1).step('a').done();
    kit.clock.advance(300_000);
    await sweepStalledOperations(kit.ctx);
    const row = await rowById(kit.env.DB, op.id);
    expect(row?.status).toBe('running');
    expect(row?.heartbeat_at).toBe(kit.clock.now());
  });

  it('resends a lease row once, then fails it on the second stall', async () => {
    const op = await start();
    await progressOf(kit.ctx, op.id, 1).step('a').done();
    kit.clock.advance(300_000);
    await sweepStalledOperations(kit.ctx);
    expect(kit.queue.sent).toContainEqual({
      kind: 'operation.run',
      operationId: op.id,
      attempt: 1,
    });
    expect((await read(op.id)).status).toBe('running');
    kit.clock.advance(300_000);
    await sweepStalledOperations(kit.ctx);
    expect((await read(op.id)).error?.code).toBe('OPERATION_STALLED');
  });

  it('leaves a recent heartbeat and a waiting row alone', async () => {
    const recent = await start();
    await progressOf(kit.ctx, recent.id, 1).step('a').done();
    const waiting = await start();
    await progressOf(kit.ctx, waiting.id, 1).waiting('a', { until: kit.clock.now() + 1000 });
    kit.clock.advance(90_000);
    await sweepStalledOperations(kit.ctx);
    kit.clock.advance(3_600_000);
    await sweepStalledOperations(kit.ctx);
    expect((await read(waiting.id)).status).toBe('waiting');
    expect(kit.queue.sent.filter((m) => (m as { kind: string }).kind === 'operation.run')).toEqual([
      { kind: 'operation.run', operationId: recent.id, attempt: 1 },
    ]);
  });
});

describe('retention sweep', () => {
  it('deletes only ended rows past their expiry', async () => {
    const done = await start();
    await progressOf(kit.ctx, done.id, 1).succeed();
    const bad = await failed();
    const active = await start();
    await run(kit.env.DB, 'UPDATE operations SET expires_at = ? WHERE id = ?', [1, active.id]);
    kit.clock.advance(8 * 86_400_000);
    await sweepOperations(kit.ctx);
    expect(await rowById(kit.env.DB, done.id)).toBeNull();
    // Failed rows keep 30 days; active rows never expire.
    expect(await rowById(kit.env.DB, bad.id)).not.toBeNull();
    expect(await rowById(kit.env.DB, active.id)).not.toBeNull();
    kit.clock.advance(23 * 86_400_000);
    await sweepOperations(kit.ctx);
    expect(await rowById(kit.env.DB, bad.id)).toBeNull();
  });
});

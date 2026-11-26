import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, toProblem } from '../../platform/errors.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { toDto } from './dto.ts';
import { ORG_KIND, registerTestKinds, STARTER_KIND } from './operations-test-fixtures.ts';
import { progressOf } from './progress.ts';
import { OperationCancelled } from './progress-types.ts';
import { rowById } from './repo.ts';
import { startOperation } from './start.ts';
import { tracked } from './tracked.ts';

let kit: Kit;
let undo: () => void;
beforeEach(async () => {
  kit = await setupKit();
  undo = registerTestKinds();
});
afterEach(() => undo());

const start = (extra: Partial<Parameters<typeof startOperation>[1]> = {}) =>
  startOperation(kit.ctx, {
    kind: ORG_KIND.kind,
    org: { orgId: kit.org.id, mode: 'live' },
    actor: { type: 'user', id: 'u1' },
    subject: { k: kit.ctx.ids.id() },
    ...extra,
  });
const read = async (id: string) => toDto((await rowById(kit.env.DB, id)) as never);

describe('startOperation', () => {
  it('creates a queued operation with the kind steps', async () => {
    const op = await start();
    expect(op).toMatchObject({ status: 'queued', title: 'Test run', text: 'Starting', attempt: 1 });
    expect(op.steps.map((s) => [s.key, s.state])).toEqual([
      ['a', 'pending'],
      ['b', 'pending'],
      ['c', 'pending'],
    ]);
  });

  it('answers the same operation for a repeated id', async () => {
    const first = await start({ id: 'fixed-id' });
    const again = await start({ id: 'fixed-id' });
    expect(again.id).toBe(first.id);
  });

  it('refuses a second active start for the subject, naming the first', async () => {
    const first = await start({ subject: { k: 'same' } });
    const error = await start({ subject: { k: 'same' } }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(toProblem(error)).toMatchObject({
      status: 409,
      code: 'OPERATION_RUNNING',
      operationId: first.id,
    });
    await progressOf(kit.ctx, first.id, 1).succeed();
    await expect(start({ subject: { k: 'same' } })).resolves.toMatchObject({ status: 'queued' });
  });

  it('keeps a starter operation 7 days from the start', async () => {
    const op = await startOperation(kit.ctx, {
      kind: STARTER_KIND.kind,
      actor: { type: 'user', id: 'u1' },
    });
    const row = await rowById(kit.env.DB, op.id);
    expect(row).toMatchObject({ org_id: null, mode: null });
    expect(row?.expires_at).toBe(kit.clock.now() + 7 * 86_400_000);
  });
});

describe('progress', () => {
  it('moves steps and counts, and ends with the tail waiting', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, op.attempt);
    await p.step('a').done();
    const b = p.step('b');
    b.total(12);
    await b.count(4);
    expect(await read(op.id)).toMatchObject({
      status: 'running',
      step: 'b',
      text: 'Doing the second · 4 of 12',
    });
    await b.done();
    await p.succeed({ href: '/admin', ids: {} });
    const done = await read(op.id);
    expect(done).toMatchObject({ status: 'succeeded', text: 'Test run done' });
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done', 'waiting']);
    expect(done.result).toEqual({ href: '/admin', ids: {} });
  });

  it('never lowers a count and writes counts at most once a second', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, op.attempt);
    const b = p.step('b');
    b.total(1000);
    await b.count(500);
    const revision = (await read(op.id)).revision;
    await b.count(100);
    await b.count(501);
    expect((await read(op.id)).revision).toBe(revision);
    expect((await read(op.id)).steps[1]?.done).toBe(500);
    kit.clock.advance(1100);
    await b.count(300);
    const after = await read(op.id);
    expect(after.steps[1]?.done).toBe(501);
    expect(after.revision).toBe(revision + 1);
  });

  it('writes a count that crosses 10% at once and the final count always', async () => {
    const op = await start();
    const b = progressOf(kit.ctx, op.id, op.attempt).step('b');
    b.total(100);
    await b.count(1);
    await b.count(12);
    expect((await read(op.id)).steps[1]?.done).toBe(12);
    await b.count(100);
    expect((await read(op.id)).steps[1]?.done).toBe(100);
  });

  it('refuses an old attempt', async () => {
    const op = await start();
    const old = progressOf(kit.ctx, op.id, 7);
    await old.step('a').done();
    await old.succeed();
    expect((await read(op.id)).status).toBe('queued');
  });

  it('does nothing without an operation id', async () => {
    const p = progressOf(kit.ctx, undefined, 1);
    await p.step('a').done();
    await p.succeed();
    await expect(p.checkCancel()).resolves.toBeUndefined();
  });

  it('waits blocked with its own words, then runs again', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, op.attempt);
    const until = kit.clock.now() + 6 * 3_600_000;
    await p.waiting('a', { until, reason: 'Waiting for Apple' });
    const waiting = await read(op.id);
    expect(waiting).toMatchObject({
      status: 'waiting',
      pollAfterMs: 60_000,
      text: 'Waiting for Apple',
    });
    expect(waiting.steps[0]).toMatchObject({ state: 'waiting', waitingReason: 'blocked', until });
    await p.step('a').done();
    const after = await read(op.id);
    expect(after.status).toBe('running');
    expect(after.steps[0]?.waitingReason).toBeNull();
  });

  it('shows a tail step as due by a date once the operation is done', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, op.attempt);
    await p.waiting('c', { until: Date.UTC(2026, 11, 2, 20), due: true });
    await p.succeed();
    const done = await read(op.id);
    expect(done.steps[2]).toMatchObject({ state: 'waiting', waitingReason: 'due' });
    expect(done.status).toBe('succeeded');
  });

  it('fails with the catalog sentence of an AppError and OPERATION_FAILED for the rest', async () => {
    const one = await start();
    const p = progressOf(kit.ctx, one.id, one.attempt);
    await p.step('a').done();
    p.step('b');
    await p.fail(new AppError('FEATURE_NOT_INCLUDED', 403, 'secret detail'));
    const failed = await read(one.id);
    expect(failed).toMatchObject({
      status: 'failed',
      step: 'b',
      error: { code: 'FEATURE_NOT_INCLUDED', message: 'Not on this plan. Retry.', retryable: true },
    });
    expect(failed.steps.map((s) => s.state)).toEqual(['done', 'failed', 'pending']);
    expect(JSON.stringify(failed)).not.toContain('secret detail');
    const two = await start();
    await progressOf(kit.ctx, two.id, two.attempt).fail(new Error('boom: user@example.com'));
    const other = await read(two.id);
    expect(other.error?.code).toBe('OPERATION_FAILED');
    expect(JSON.stringify(other)).not.toContain('user@example.com');
  });

  it('stops at a safe boundary once cancel was asked for', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, op.attempt);
    await p.step('a').done();
    await expect(p.checkCancel()).resolves.toBeUndefined();
    await kit.env.DB.prepare('UPDATE operations SET cancel_requested = 1 WHERE id = ?')
      .bind(op.id)
      .run();
    kit.clock.advance(2000);
    await expect(p.checkCancel()).rejects.toBeInstanceOf(OperationCancelled);
    await p.fail(new OperationCancelled());
    const stopped = await read(op.id);
    expect(stopped).toMatchObject({ status: 'cancelled', text: 'Stopped' });
    expect(stopped.steps.map((s) => s.state)).toEqual(['done', 'skipped', 'skipped']);
  });

  it('never fails the job when a progress write fails', async () => {
    const op = await start();
    const real = kit.env.DB;
    const broken = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            if (sql.startsWith('UPDATE operations')) throw new Error('d1 down');
            return target.prepare(sql);
          };
        return Reflect.get(target, prop);
      },
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: broken } };
    const p = progressOf(ctx, op.id, op.attempt);
    await expect(p.step('a').done()).resolves.toBeUndefined();
    await expect(p.succeed()).resolves.toBeUndefined();
    expect((await read(op.id)).status).toBe('queued');
  });
});

describe('tracked', () => {
  const fakeStep = () => ({
    do: async (_name: string, a: unknown, b?: () => Promise<unknown>) =>
      (typeof a === 'function' ? (a as () => Promise<unknown>) : (b as () => Promise<unknown>))(),
  });

  it('starts and ends a step inside the callback, and a re-run of a finished step writes nothing', async () => {
    const op = await start();
    const p = progressOf(kit.ctx, op.id, op.attempt);
    const step = fakeStep();
    await tracked(step as never, 'do-a', p, 'a', async () => 1);
    const afterFirst = await read(op.id);
    expect(afterFirst.steps[0]?.state).toBe('done');
    // A fresh runner (a replayed isolate) runs the callback of the finished step again.
    const replay = progressOf(kit.ctx, op.id, op.attempt);
    await tracked(step as never, 'do-a', replay, 'a', async (h) => {
      h.total(5);
      await h.count(3);
      return 2;
    });
    expect((await read(op.id)).revision).toBe(afterFirst.revision);
  });
});

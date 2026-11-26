import { describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupTenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { ORIGIN, setupScanKit } from '../scan/test-kit.ts';

/** A holder signs in by email link, so every session here is `magic_link`: own-only. */
async function setup() {
  const kit = await setupScanKit();
  const queued: Job[] = [];
  kit.env.JOBS = {
    send: vi.fn(async (job: Job) => void queued.push(job)),
    sendBatch: vi.fn(),
  } as unknown as Queue;
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  const auth = await setupTenantTestAuth(kit);
  const templateId = await kit.scanTemplate('Holder ops', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const user = await makeUser(kit.fx);
  const stranger = await makeUser(kit.fx);
  const pass = await kit.scanPass(templateId, {}, { holderEmail: user.primaryEmail });
  const theirs = await kit.scanPass(templateId, {}, { holderEmail: stranger.primaryEmail });
  const session = (userId: string) => makeSession(kit.fx, { userId, amr: 'magic_link' });
  const mine = await session(user.id);
  const app = createApp({ clock: kit.clock, stores: auth.stores });
  const send = (method: string, path: string, headers: Record<string, string>) =>
    Promise.resolve(app.request(`${ORIGIN}${path}`, { method, headers }, kit.env));
  const post = (path: string, headers = mine.headers) => send('POST', `/api/v1/me${path}`, headers);
  const read = async (id: string, headers = mine.headers) =>
    send('GET', `/api/v1/operations/${id}`, headers);
  const operation = async (id: string, headers = mine.headers) =>
    (await (await read(id, headers)).json()) as OperationDto;
  const drain = async () => {
    for (const job of queued.splice(0)) await runJob(job, jobCtxOf(kit));
  };
  return {
    kit,
    auth,
    queued,
    user,
    stranger,
    pass,
    theirs,
    mine,
    session,
    post,
    read,
    operation,
    send,
    drain,
  };
}

const states = (op: OperationDto) => Object.fromEntries(op.steps.map((s) => [s.key, s.state]));

describe('lost phone as an operation', () => {
  it('shows each step to the session that started it, and ends done', async () => {
    const { pass, post, operation, drain, user, queued } = await setup();
    const res = await post(`/passes/${pass.id}/lost-phone`);
    expect(res.status).toBe(202);
    const { operationId } = (await res.json()) as { operationId: string };
    expect(operationId).toEqual(expect.any(String));
    // The mail job carries the id, so the steps after the request report from the queue.
    expect(queued).toContainEqual(
      expect.objectContaining({ kind: 'pass.holder_mail', reason: 'lost_phone', operationId }),
    );
    const mid = await operation(operationId);
    expect(mid).toMatchObject({
      kind: 'holder.lost_phone',
      status: 'running',
      target: { type: 'pass', id: pass.id },
    });
    expect(states(mid)).toEqual({
      rotate: 'done',
      signout: 'done',
      wallets: 'skipped',
      mail: 'pending',
    });
    await drain();
    const done = await operation(operationId);
    expect(done.status).toBe('succeeded');
    expect(done.text).toBe('New pass sent');
    expect(states(done)).toEqual({
      rotate: 'done',
      signout: 'done',
      wallets: 'skipped',
      mail: 'done',
    });
    // No address anywhere in what the API says about it.
    const text = JSON.stringify(done);
    expect(text).not.toContain(user.primaryEmail);
    expect(text).not.toContain('@');
  });

  it('the holder can still read it after the other sessions are signed out', async () => {
    const { pass, post, operation, session, user, read } = await setup();
    const other = await session(user.id);
    const { operationId } = (await (await post(`/passes/${pass.id}/lost-phone`)).json()) as {
      operationId: string;
    };
    expect((await read(operationId)).status).toBe(200);
    expect(await operation(operationId)).toMatchObject({ id: operationId });
    // The session that was signed out reads nothing.
    expect((await read(operationId, other.headers)).status).toBe(401);
  });
});

describe('who can read a holder operation', () => {
  it('no other holder, org member, platform admin, API key or other session of the same person', async () => {
    const { pass, post, read, auth, session, user, stranger } = await setup();
    const olderSession = await session(user.id);
    const { operationId } = (await (await post(`/passes/${pass.id}/resend`)).json()) as {
      operationId: string;
    };
    expect((await read(operationId)).status).toBe(200);
    const stranger1 = await session(stranger.id);
    for (const headers of [
      stranger1.headers,
      auth.admin(),
      auth.user(),
      olderSession.headers,
      await auth.apiKey({ scopes: ['passes:read', 'passes:write'] }),
    ]) {
      const res = await read(operationId, headers);
      expect([401, 403, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }
  });

  it('a list answers only the holder own operations, and never to a key', async () => {
    const { pass, theirs, post, session, stranger, send, mine, auth } = await setup();
    const a = (await (await post(`/passes/${pass.id}/resend`)).json()) as { operationId: string };
    const other = await session(stranger.id);
    await post(`/passes/${theirs.id}/resend`, other.headers);
    const list = async (headers: Record<string, string>) => {
      const res = await send('GET', '/api/v1/operations?mine=true&active=true', headers);
      return res.status === 200
        ? ((await res.json()) as { items: OperationDto[] }).items.map((o) => o.id)
        : res.status;
    };
    expect(await list(mine.headers)).toEqual([a.operationId]);
    expect(await list(auth.admin())).not.toContain(a.operationId);
    const key = await auth.apiKey({ scopes: ['passes:read'] });
    const keyed = await list(key);
    expect(Array.isArray(keyed) ? keyed : []).not.toContain(a.operationId);
  });

  it('refuses a holder reading another holder pass through an action', async () => {
    const { theirs, post } = await setup();
    await expectProblem(await post(`/passes/${theirs.id}/resend`), 404, 'PASS_NOT_FOUND');
  });
});

describe('resend as an operation', () => {
  it('queues the mail with the id, and ends done once it is sent', async () => {
    const { pass, post, operation, drain, queued } = await setup();
    const { operationId } = (await (await post(`/passes/${pass.id}/resend`)).json()) as {
      operationId: string;
    };
    expect(queued).toContainEqual(
      expect.objectContaining({ kind: 'pass.holder_mail', reason: 'resend', operationId }),
    );
    expect(states(await operation(operationId))).toEqual({ check: 'done', mail: 'pending' });
    await drain();
    const done = await operation(operationId);
    expect(done).toMatchObject({ status: 'succeeded', text: 'Email on its way' });
    expect(states(done)).toEqual({ check: 'done', mail: 'done' });
  });

  it('a second tap while the first runs answers 409 with the first id', async () => {
    const { pass, post } = await setup();
    const first = (await (await post(`/passes/${pass.id}/resend`)).json()) as {
      operationId: string;
    };
    const again = await post(`/passes/${pass.id}/resend`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: 'OPERATION_RUNNING',
      operationId: first.operationId,
    });
  });

  it('ends failed with a catalog sentence when the pass is gone by the time the job runs', async () => {
    const { pass, post, operation, drain, kit } = await setup();
    const { operationId } = (await (await post(`/passes/${pass.id}/resend`)).json()) as {
      operationId: string;
    };
    await kit.env.DB.prepare("UPDATE passes SET status = 'voided' WHERE id = ?")
      .bind(pass.id)
      .run();
    await drain();
    const failed = await operation(operationId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({
      code: 'PASS_NOT_FOUND',
      message: 'This pass is not available.',
      step: 'mail',
      retryable: false,
    });
    expect(JSON.stringify(failed)).not.toContain('@');
  });
});

describe('refresh as an operation', () => {
  it('starts when the claim is won and ends done once the push is queued', async () => {
    const { pass, post, operation, drain, queued } = await setup();
    const res = await post(`/passes/${pass.id}/refresh`);
    expect(res.status).toBe(202);
    const { operationId } = (await res.json()) as { operationId: string };
    expect(queued).toContainEqual(
      expect.objectContaining({ kind: 'pass.refresh', operationId, passId: pass.id }),
    );
    expect(states(await operation(operationId))).toMatchObject({ check: 'done', build: 'pending' });
    await drain();
    const done = await operation(operationId);
    expect(done).toMatchObject({
      kind: 'holder.refresh',
      status: 'succeeded',
      text: 'Pass updated',
    });
    expect(states(done)).toEqual({ check: 'done', build: 'done', wallets: 'done' });
  });

  it('a click inside the cooldown joins the running refresh instead of starting another', async () => {
    const { pass, post, queued } = await setup();
    const first = (await (await post(`/passes/${pass.id}/refresh`)).json()) as {
      operationId: string;
    };
    const second = (await (await post(`/passes/${pass.id}/refresh`)).json()) as {
      operationId?: string;
    };
    expect(second.operationId).toBe(first.operationId);
    expect(queued.filter((j) => j.kind === 'pass.refresh')).toHaveLength(1);
  });
});

describe('removal as an operation', () => {
  it('a removal that settles at once is done in the same breath', async () => {
    const { pass, send, mine, operation } = await setup();
    const res = await send('DELETE', `/api/v1/me/passes/${pass.id}`, mine.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operationId: string; state: string };
    expect(body.state).toBe('completed');
    const done = await operation(body.operationId);
    expect(done).toMatchObject({
      kind: 'holder.remove',
      status: 'succeeded',
      text: 'Pass removed',
    });
    expect(states(done)).toEqual({ account: 'done', wallets: 'skipped' });
  });
});

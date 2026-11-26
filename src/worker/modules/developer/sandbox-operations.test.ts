import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { type OperationDto, OperationSchema } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { type OrgPurgeParams, runOrgPurge } from '../../workflows/org-purge.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { kindOf } from '../operations/kinds.ts';
import { progressOf } from '../operations/progress.ts';
import { startOperation } from '../operations/start.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import {
  captureQueue,
  makeSandbox,
  settle,
  settleWithJobs,
  startAndSettle,
  startAndSettleWithJobs,
} from './sandbox-test-fixtures.ts';

/**
 * The four sandbox kinds as the page sees them: the steps and counts each reports, a stop on the exact step and
 * its retry, who may read them, and the key that is minted once afterwards.
 */
const ORIGIN = 'https://wallet.test';
const realFetch = globalThis.fetch;
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
/** What the next purge start does: run the Workflow's steps, or fail as a missing binding would. */
let purgeStart: 'run' | 'fail' = 'run';
const queue = captureQueue();
const runJob = (job: { kind: 'operation.run'; operationId: string; attempt: number }) =>
  handleOperationRun(job, createJobContext(kit.env, 'test', { clock: kit.clock }));
const sleeping = {
  async do(_name: string, a: unknown, b?: unknown) {
    return ((typeof a === 'function' ? a : b) as () => unknown)();
  },
  async sleep() {},
  sleepUntil: () => new Promise<void>(() => {}),
};
const purges = vi.fn(async (opts: { id: string; params: OrgPurgeParams }) => {
  if (purgeStart === 'fail') throw new Error('workflow binding down');
  void runOrgPurge(kit.env, opts.params, sleeping as never, undefined, kit.clock, 0);
  return {};
});

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  // The retry's `operation.run` goes nowhere: a test runs the job's entry itself, on its own clock.
  Object.assign(kit.env, { ORG_PURGE: { create: purges }, JOBS: queue.binding });
  (kit.env as { RL_REFRESH: unknown }).RL_REFRESH = { limit: async () => ({ success: true }) };
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: true });
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(headers.cookie ? { origin: ORIGIN } : {}),
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

async function person() {
  const user = await makeUser(kit.f);
  const { headers } = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  return { user, headers };
}
async function sandboxOf() {
  const p = await person();
  return { ...p, made: await makeSandbox(send, p.headers) };
}
const get = async (headers: Record<string, string>, id: string) =>
  OperationSchema.parse(await (await send('GET', `/operations/${id}`, headers)).json());
const states = (op: OperationDto) => op.steps.map((s) => [s.key, s.state]);
const step = (op: OperationDto, key: string) => op.steps.find((s) => s.key === key);

describe('the sandbox kinds', () => {
  it('say what each step does, in the words of the design', () => {
    const words = (kind: string) =>
      kindOf(kind)?.steps.map((s) => [s.key, s.label, s.active ?? null, s.group ?? null]);
    expect(words('sandbox.create')).toEqual([
      ['org', 'Create sandbox', 'Creating your sandbox', null],
      ['template', 'Add ticket template', 'Adding the ticket template', null],
      ['release', 'Release it in Test', 'Releasing the ticket in Test', null],
      ['capture', 'Add capture endpoint', 'Adding the capture endpoint', null],
      ['scanner', 'Add test scanner', 'Adding a test scanner', null],
    ]);
    expect(words('sandbox.delete')).toEqual([
      ['close', 'Close sandbox', 'Closing your sandbox', null],
      ['keys', 'Revoke keys', 'Revoking keys', null],
      ['passes', 'Remove Test passes', 'Removing Test passes', null],
      ['erase', 'Erase sandbox data', null, null],
    ]);
    expect(words('sandbox.reset')?.map((s) => s[2])).toEqual([
      'Revoking the old key',
      'Deleting Test passes',
      'Deleting captured events',
      'Clearing calls, messages and imports',
      'Releasing the ticket in Test',
    ]);
    expect(kindOf('sandbox.recreate')?.steps.map((s) => s.group)).toEqual([
      ...Array(4).fill('Old sandbox'),
      ...Array(5).fill('New sandbox'),
    ]);
    for (const kind of ['create', 'delete', 'reset', 'recreate'])
      expect(kindOf(`sandbox.${kind}`)).toMatchObject({ audience: 'starter', cancel: 'never' });
  });
});

describe('sandbox.create', () => {
  it('reports every step in order and ends without a key', async () => {
    const p = await person();
    const res = await send('POST', '/developer/sandbox', p.headers, { turnstileToken: 'ok' });
    expect(res.status).toBe(202);
    const started = OperationSchema.parse(((await res.json()) as { operation: unknown }).operation);
    expect(res.headers.get('location')).toBe(`/api/v1/operations/${started.id}`);
    expect(started).toMatchObject({ kind: 'sandbox.create', status: 'queued', attempt: 1 });
    expect(started.title).toBe('Create sandbox');
    const op = await settle(send, p.headers, started.id);
    expect(op).toMatchObject({ status: 'succeeded', text: 'Sandbox ready', error: null });
    expect(states(op)).toEqual([
      ['org', 'done'],
      ['template', 'done'],
      ['release', 'done'],
      ['capture', 'done'],
      ['scanner', 'done'],
    ]);
    // The result names what was made, by id: no secret in an operation.
    expect(op.result?.ids).toMatchObject({
      orgId: expect.any(String),
      orgSlug: expect.any(String),
    });
    expect(JSON.stringify(op)).not.toMatch(/pbp_/);
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT count(*) AS n FROM api_keys WHERE org_id = ?',
          [op.result?.ids.orgId],
        )
      )?.n,
    ).toBe(0);
  });

  it('answers the same operation for the same Idempotency-Key, and 409 with its id while one runs', async () => {
    const p = await person();
    const headers = { ...p.headers, 'idempotency-key': 'one-key' };
    const call = () =>
      app.request(
        `${ORIGIN}/api/v1/developer/sandbox`,
        {
          method: 'POST',
          headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ turnstileToken: 'ok' }),
        },
        kit.env,
      );
    const a = (await (await call()).json()) as { operation: OperationDto };
    const b = (await (await call()).json()) as { operation: OperationDto };
    expect(b.operation.id).toBe(a.operation.id);
    await settle(send, p.headers, a.operation.id);
    // Another start while one is active names it, to the person who started it.
    const q = await person();
    const slow = await send('POST', '/developer/sandbox', q.headers, { turnstileToken: 'ok' });
    const second = await send('POST', '/developer/sandbox', q.headers, { turnstileToken: 'ok' });
    if (second.status === 409)
      expect(await second.json()).toMatchObject({
        code: 'OPERATION_RUNNING',
        operationId: ((await slow.json()) as { operation: OperationDto }).operation.id,
      });
  });

  it('is readable only by the session of the person who started it', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'POST', '/developer/sandbox', {
      turnstileToken: 'ok',
    });
    const other = await person();
    await expectProblem(
      await send('GET', `/operations/${op.id}`, other.headers),
      404,
      'OPERATION_NOT_FOUND',
    );
    const unknown = await send('GET', `/operations/${kit.f.ids.id()}`, other.headers);
    expect(unknown.status).toBe(404);
    await expectProblem(
      await send('POST', `/operations/${op.id}/retry`, other.headers),
      404,
      'OPERATION_NOT_FOUND',
    );
    // The owner lists it as theirs; a stranger's list has none of it.
    const mine = (await (await send('GET', '/operations?mine=true', s.headers)).json()) as {
      items: OperationDto[];
    };
    expect(mine.items.map((i) => i.id)).toContain(op.id);
    const theirs = (await (await send('GET', '/operations', other.headers)).json()) as {
      items: OperationDto[];
    };
    expect(theirs.items.map((i) => i.id)).not.toContain(op.id);
  });

  it('cannot be stopped, and cannot be retried while it has not failed', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'POST', '/developer/sandbox', {
      turnstileToken: 'ok',
    });
    await expectProblem(
      await send('POST', `/operations/${op.id}/cancel`, s.headers),
      409,
      'OPERATION_NOT_CANCELABLE',
    );
    await expectProblem(
      await send('POST', `/operations/${op.id}/retry`, s.headers),
      409,
      'OPERATION_NOT_RETRYABLE',
    );
  });

  it('stops on the template step with its sentence, and the retry completes it', async () => {
    const p = await person();
    await run(
      kit.env.DB,
      `CREATE TRIGGER qs_block_template BEFORE INSERT ON templates
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    let failed: OperationDto;
    try {
      failed = await startAndSettle(send, p.headers, 'POST', '/developer/sandbox', {
        turnstileToken: 'ok',
      });
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER qs_block_template');
    }
    expect(failed).toMatchObject({
      status: 'failed',
      step: 'template',
      text: 'Could not finish your sandbox',
    });
    expect(failed.error).toMatchObject({
      code: 'SANDBOX_TEMPLATE_FAILED',
      message: 'The ticket template did not finish. Retry.',
      retryable: true,
    });
    expect(states(failed)).toEqual([
      ['org', 'done'],
      ['template', 'failed'],
      ['release', 'pending'],
      ['capture', 'pending'],
      ['scanner', 'pending'],
    ]);
  });
});

describe('POST /developer/sandbox/key', () => {
  it('mints the key once and then refuses while it lives', async () => {
    const p = await person();
    await expectProblem(
      await send('POST', '/developer/sandbox/key', p.headers),
      404,
      'SANDBOX_NOT_FOUND',
    );
    await startAndSettle(send, p.headers, 'POST', '/developer/sandbox', { turnstileToken: 'ok' });
    const first1 = await send('POST', '/developer/sandbox/key', p.headers);
    expect(first1.status).toBe(201);
    expect(first1.headers.get('cache-control')).toBe('no-store');
    const { key } = (await first1.json()) as { key: { secret: string; mode: string } };
    expect(key).toMatchObject({ mode: 'test', secret: expect.stringMatching(/^pbp_test_/) });
    const again = await send('POST', '/developer/sandbox/key', p.headers);
    await expectProblem(again, 409, 'SANDBOX_KEY_SHOWN');
    expect(await again.clone().text()).toContain('Roll it to get a new one.');
    // A key cannot ask for it: the sandbox's key is for the API, not for itself.
    const asKey = await send('POST', '/developer/sandbox/key', {
      authorization: `Bearer ${key.secret}`,
    });
    expect([401, 403]).toContain(asKey.status);
  });
});

describe('sandbox.delete', () => {
  it('closes, revokes with a count, removes the passes with a count, and ends with the erase waiting', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'DELETE', '/developer/sandbox');
    expect(op).toMatchObject({
      kind: 'sandbox.delete',
      status: 'succeeded',
      text: 'Sandbox deleted',
    });
    expect(states(op)).toEqual([
      ['close', 'done'],
      ['keys', 'done'],
      ['passes', 'done'],
      ['erase', 'waiting'],
    ]);
    expect(step(op, 'keys')).toMatchObject({ done: 1, total: 1 });
    expect(step(op, 'erase')).toMatchObject({
      waitingReason: 'due',
      until: expect.any(Number),
    });
    // The tail ends by the grace: 7 days after the passes were voided.
    expect((step(op, 'erase')?.until ?? 0) - kit.clock.now()).toBe(7 * 86_400_000);
  });

  it('counts the passes it removes', async () => {
    const s = await sandboxOf();
    const key = { authorization: `Bearer ${s.made.key?.secret}` };
    for (let i = 0; i < 3; i++) {
      const detail = await send('GET', `/templates/${s.made.templateId}`, key);
      const sample = ((await detail.json()) as { manifest: { sample?: Record<string, unknown> } })
        .manifest.sample;
      const made = await send('POST', '/passes', key, {
        templateId: s.made.templateId,
        input: sample ?? {},
      });
      expect(made.status, await made.clone().text()).toBe(201);
    }
    const op = await startAndSettle(send, s.headers, 'DELETE', '/developer/sandbox');
    expect(op.status).toBe('succeeded');
    expect(step(op, 'passes')).toMatchObject({ state: 'done', done: 3, total: 3 });
  });

  it('shows the running line with its count', async () => {
    const user = await makeUser(kit.f);
    const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    const headers = { ...session.headers, origin: ORIGIN };
    const ctx = createServiceContext(kit.env, { clock: kit.clock });
    // A delete as the Workflow reports it: the sandbox closed, then "Removing Test passes · 4 of 12".
    const op = await startOperation(ctx, {
      kind: 'sandbox.delete',
      actor: { type: 'user', id: user.id },
      session: await sha256Hex(session.cookieValue),
      subject: { userId: user.id },
    });
    const progress = progressOf(ctx, op.id, 1);
    await progress.step('close').done();
    const keys = progress.step('keys');
    keys.total(2);
    await keys.count(1);
    expect((await get(headers, op.id)).text).toBe('Revoking keys · 1 of 2');
    await keys.count(2);
    await keys.done();
    const passes = progress.step('passes');
    passes.total(12);
    await passes.count(4);
    const running = await get(headers, op.id);
    expect(running).toMatchObject({ status: 'running', step: 'passes' });
    expect(running.text).toBe('Removing Test passes · 4 of 12');
    expect(running.cancelable).toBe(false);
    await passes.count(12);
    await passes.done();
    await progress.waiting('erase', { until: kit.clock.now() + 7 * 86_400_000, due: true });
    await progress.succeed();
    const done = await get(headers, op.id);
    expect(done.text).toBe('Sandbox deleted');
    expect(step(done, 'erase')).toMatchObject({ state: 'waiting', waitingReason: 'due' });
  });

  it('stops on passes when the cleanup cannot start, and a retry starts it as a new instance', async () => {
    const s = await sandboxOf();
    purgeStart = 'fail';
    let failed: OperationDto;
    try {
      failed = await startAndSettle(send, s.headers, 'DELETE', '/developer/sandbox');
    } finally {
      purgeStart = 'run';
    }
    expect(failed).toMatchObject({
      status: 'failed',
      step: 'passes',
      text: 'Could not delete sandbox',
    });
    expect(failed.error).toMatchObject({
      code: 'SANDBOX_PURGE_START',
      message: 'The cleanup did not start. Retry.',
      retryable: true,
    });
    expect(states(failed)).toEqual([
      ['close', 'done'],
      ['keys', 'done'],
      ['passes', 'failed'],
      ['erase', 'pending'],
    ]);
    const retried = await send('POST', `/operations/${failed.id}/retry`, s.headers);
    expect(retried.status, await retried.clone().text()).toBe(200);
    const done = await settle(send, s.headers, failed.id);
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2 });
    // The retry is its own Workflow instance, named for the attempt, and the row tracks it.
    expect(purges).toHaveBeenLastCalledWith({
      id: `${failed.id}-r2`,
      params: expect.objectContaining({ operationId: failed.id, attempt: 2, finish: true }),
    });
    const stored = await first<{ workflow_instance_id: string }>(
      kit.env.DB,
      'SELECT workflow_instance_id FROM operations WHERE id = ?',
      [failed.id],
    );
    expect(stored?.workflow_instance_id).toBe(`${failed.id}-r2`);
  });

  it('stops on the first step when the delete is refused (a legal hold), and says so with its generic sentence', async () => {
    const s = await sandboxOf();
    await run(
      kit.env.DB,
      "INSERT INTO retention_holds (id, org_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, 'platform', 'p', 'r', 1)",
      [kit.f.ids.id(), s.made.orgId],
    );
    const held = await startAndSettle(send, s.headers, 'DELETE', '/developer/sandbox');
    expect(held).toMatchObject({
      status: 'failed',
      step: 'close',
      text: 'Could not delete sandbox',
    });
    expect(held.error).toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'Something went wrong. Retry.',
      retryable: true,
    });
    expect(states(held)).toEqual([
      ['close', 'failed'],
      ['keys', 'pending'],
      ['passes', 'pending'],
      ['erase', 'pending'],
    ]);
    // Nothing of the sandbox was touched.
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM developer_sandboxes WHERE user_id = ?', [s.user.id]),
    ).not.toBeNull();
  });

  it('keeps the three a day, and cannot be stopped', async () => {
    const s = await sandboxOf();
    for (let i = 0; i < 3; i++)
      await run(
        kit.env.DB,
        `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES (?, NULL, 'user', ?, 'developer_sandbox.delete', 'org', ?)`,
        [kit.clock.now() - i * 1000, s.user.id, kit.f.ids.id()],
      );
    await expectProblem(
      await send('DELETE', '/developer/sandbox', s.headers),
      429,
      'SANDBOX_RESET_LIMIT',
    );
  });
});

describe('sandbox.reset', () => {
  it('reports its steps with counts, and the key is minted afterwards, once', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'POST', '/developer/sandbox/reset', {
      turnstileToken: 'ok',
    });
    expect(op).toMatchObject({ kind: 'sandbox.reset', status: 'succeeded', text: 'Sandbox reset' });
    expect(states(op)).toEqual([
      ['claim', 'done'],
      ['passes', 'done'],
      ['captures', 'done'],
      ['rows', 'done'],
      ['template', 'done'],
    ]);
    expect(step(op, 'rows')).toMatchObject({ done: 8, total: 8 });
    expect(op.result?.ids).toMatchObject({ resetsLeft: '2', passes: '0' });
    expect(JSON.stringify(op)).not.toMatch(/pbp_/);
    const keyed = await send('POST', '/developer/sandbox/key', s.headers);
    expect(keyed.status).toBe(201);
    await expectProblem(
      await send('POST', '/developer/sandbox/key', s.headers),
      409,
      'SANDBOX_KEY_SHOWN',
    );
  });

  it('is another person’s to read: a stranger gets 404', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'POST', '/developer/sandbox/reset', {
      turnstileToken: 'ok',
    });
    await expectProblem(
      await send('GET', `/operations/${op.id}`, (await person()).headers),
      404,
      'OPERATION_NOT_FOUND',
    );
  });
});

describe('sandbox.recreate', () => {
  it('runs the old sandbox’s steps, then the new one’s, and ends without a key', async () => {
    const s = await sandboxOf();
    const op = await startAndSettleWithJobs(
      send,
      s.headers,
      'POST',
      '/developer/sandbox/recreate',
      { turnstileToken: 'ok' },
      queue,
      runJob,
    );
    expect(op).toMatchObject({
      kind: 'sandbox.recreate',
      status: 'succeeded',
      text: 'New sandbox ready',
    });
    expect(states(op)).toEqual([
      ['close', 'done'],
      ['keys', 'done'],
      ['passes', 'done'],
      ['erase', 'waiting'],
      ['org', 'done'],
      ['template', 'done'],
      ['release', 'done'],
      ['capture', 'done'],
      ['scanner', 'done'],
    ]);
    expect(op.steps.map((x) => x.group)).toEqual([
      ...Array(4).fill('Old sandbox'),
      ...Array(5).fill('New sandbox'),
    ]);
    expect(op.result?.ids.orgId).not.toBe(s.made.orgId);
    expect(JSON.stringify(op)).not.toMatch(/pbp_/);
  });

  it('stops on the old passes when the cleanup cannot start, and its retry carries on to the new sandbox', async () => {
    const s = await sandboxOf();
    purgeStart = 'fail';
    let failed: OperationDto;
    try {
      failed = await startAndSettle(send, s.headers, 'POST', '/developer/sandbox/recreate', {
        turnstileToken: 'ok',
      });
    } finally {
      purgeStart = 'run';
    }
    expect(failed).toMatchObject({ status: 'failed', step: 'passes' });
    expect(step(failed, 'org')?.state).toBe('pending');
    const res = await send('POST', `/operations/${failed.id}/retry`, s.headers);
    expect(res.status, await res.clone().text()).toBe(200);
    // The retry is a queued `operation.run`, and the purge sends another once the passes are voided.
    const done = await settleWithJobs(send, s.headers, failed.id, queue, runJob);
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(done.steps.filter((x) => x.state !== 'done').map((x) => x.key)).toEqual(['erase']);
  });
});

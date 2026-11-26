import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { type OperationDto, OperationSchema } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { type OrgPurgeParams, runOrgPurge } from '../../workflows/org-purge.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { NOOP } from '../operations/progress-types.ts';
import { markResent } from '../operations/repo-sweep.ts';
import { startOperation } from '../operations/start.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { resetSandbox } from './reset.ts';
import {
  captureQueue,
  makeSandbox,
  settle,
  settleWithJobs,
  startAndSettle,
  startAndSettleWithJobs,
} from './sandbox-test-fixtures.ts';

/**
 * A run belongs to the operation's own sandbox. A retry, a resume or a repeat never reaches a newer sandbox of the
 * person, never runs twice, and keeps working after a step-up.
 */
const ORIGIN = 'https://wallet.test';
const realFetch = globalThis.fetch;
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
let purgeStart: 'run' | 'fail' = 'run';
let purgeStatus: (() => Promise<{ status: string }>) | null = null;
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
const created = new Set<string>();
const purges = vi.fn(async (opts: { id: string; params: OrgPurgeParams }) => {
  if (purgeStart === 'fail') throw new Error('workflow binding down');
  created.add(opts.id);
  void runOrgPurge(kit.env, opts.params, sleeping as never, undefined, kit.clock, 0);
  return {};
});

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  Object.assign(kit.env, {
    ORG_PURGE: {
      create: purges,
      // An instance that was never created is "not found", as the real binding says.
      get: async (id: string) => {
        if (!created.has(id)) throw new Error('instance.not_found');
        return { status: purgeStatus ?? (async () => ({ status: 'errored' })) };
      },
    },
    JOBS: queue.binding,
  });
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

const send = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  key: string = kit.f.ids.token(),
) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const sendAny: Parameters<typeof makeSandbox>[0] = (m, p, h, b) => send(m, p, h, b);

async function person() {
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, {
    userId: user.id,
    roles: ['user', 'developer'],
    amr: 'oidc',
  });
  return { user, headers: session.headers, session };
}
async function sandboxOf() {
  const p = await person();
  return { ...p, made: await makeSandbox(sendAny, p.headers) };
}
const orgStatus = async (id: string) =>
  (await first<{ status: string }>(kit.env.DB, 'SELECT status FROM orgs WHERE id = ?', [id]))
    ?.status;
const hasRecord = async (userId: string) =>
  (await first(kit.env.DB, 'SELECT 1 FROM developer_sandboxes WHERE user_id = ?', [userId])) !==
  null;
const deletesOf = async (userId: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'developer_sandbox.delete' AND actor_id = ?",
      [userId],
    )
  )?.n ?? 0;
const getOp = async (headers: Record<string, string>, id: string) =>
  OperationSchema.parse(await (await send('GET', `/operations/${id}`, headers)).json());
const failDelete = async (headers: Record<string, string>) => {
  purgeStart = 'fail';
  try {
    return await startAndSettle(send, headers, 'DELETE', '/developer/sandbox');
  } finally {
    purgeStart = 'run';
  }
};
const blockTemplates = (on: boolean) =>
  on
    ? run(
        kit.env.DB,
        `CREATE TRIGGER pin_block_template BEFORE INSERT ON templates BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      )
    : run(kit.env.DB, 'DROP TRIGGER pin_block_template');

describe('a run is pinned to its operation’s sandbox (H1)', () => {
  it('a retried delete leaves the person’s newer sandbox alone', async () => {
    const s = await sandboxOf();
    const failed = await failDelete(s.headers);
    expect(failed).toMatchObject({ status: 'failed', step: 'passes' });
    const newer = await makeSandbox(sendAny, s.headers);
    expect(newer.orgId).not.toBe(s.made.orgId);
    const res = await send('POST', `/operations/${failed.id}/retry`, s.headers);
    expect(res.status, await res.clone().text()).toBe(202);
    const done = await settle(send, s.headers, failed.id);
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(done.result?.ids.orgId).toBe(s.made.orgId);
    expect(await orgStatus(newer.orgId)).toBe('active');
    expect(await hasRecord(s.user.id)).toBe(true);
    expect(await deletesOf(s.user.id)).toBe(1);
  });

  it('a retried start over finishes the sandbox it made, and deletes nothing twice', async () => {
    const s = await sandboxOf();
    await blockTemplates(true);
    let failed: OperationDto;
    try {
      failed = await startAndSettleWithJobs(
        send,
        s.headers,
        'POST',
        '/developer/sandbox/recreate',
        { turnstileToken: 'ok' },
        queue,
        runJob,
      );
    } finally {
      await blockTemplates(false);
    }
    // The new half failed on its own step: the erase tail is not what failed.
    expect(failed).toMatchObject({ status: 'failed', step: 'template' });
    expect(failed.steps.find((x) => x.key === 'erase')?.state).toBe('waiting');
    const made = await first<{ org_id: string }>(
      kit.env.DB,
      'SELECT org_id FROM developer_sandboxes WHERE user_id = ?',
      [s.user.id],
    );
    expect(made?.org_id).toBeTruthy();
    expect(await deletesOf(s.user.id)).toBe(1);
    const res = await send('POST', `/operations/${failed.id}/retry`, s.headers);
    expect(res.status, await res.clone().text()).toBe(202);
    const done = await settleWithJobs(send, s.headers, failed.id, queue, runJob);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.result?.ids.orgId).toBe(made?.org_id);
    expect(await orgStatus(made?.org_id as string)).toBe('active');
    expect(await deletesOf(s.user.id)).toBe(1);
  });

  it('the 90 second backstop resumes a start over without deleting the sandbox it made', async () => {
    const s = await sandboxOf();
    await blockTemplates(true);
    let failed: OperationDto;
    try {
      failed = await startAndSettleWithJobs(
        send,
        s.headers,
        'POST',
        '/developer/sandbox/recreate',
        { turnstileToken: 'ok' },
        queue,
        runJob,
      );
    } finally {
      await blockTemplates(false);
    }
    const made = await first<{ org_id: string }>(
      kit.env.DB,
      'SELECT org_id FROM developer_sandboxes WHERE user_id = ?',
      [s.user.id],
    );
    // The run died after the new org step: the row still says running, with no lease.
    await run(
      kit.env.DB,
      `UPDATE operations SET status = 'running', error_code = NULL, error_step = NULL, error_retryable = NULL,
         finished_at = NULL, lease_until = NULL, lease_owner = NULL WHERE id = ?`,
      [failed.id],
    );
    await runJob({ kind: 'operation.run', operationId: failed.id, attempt: 1 });
    const done = await getOp(s.headers, failed.id);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.result?.ids.orgId).toBe(made?.org_id);
    expect(await deletesOf(s.user.id)).toBe(1);
  });

  it('a reset claimed on one sandbox refuses to wipe a newer one', async () => {
    const s = await sandboxOf();
    await startAndSettle(send, s.headers, 'DELETE', '/developer/sandbox');
    const newer = await makeSandbox(sendAny, s.headers);
    const auth: SessionAuth = {
      kind: 'session',
      userId: s.user.id,
      sessionId: await sha256Hex(s.session.cookieValue),
      roles: ['user', 'developer'],
      csrfSecret: s.session.csrf,
      amr: 'oidc',
      authTime: kit.clock.now(),
      mode: 'live',
    };
    const old = {
      target: { type: 'sandbox', id: s.made.orgId },
      steps: [{ key: 'claim', state: 'done' }],
    } as never;
    await expect(
      resetSandbox(createServiceContext(kit.env, { clock: kit.clock }), auth, old, NOOP),
    ).rejects.toMatchObject({ code: 'SANDBOX_CONFLICT' });
    expect(await orgStatus(newer.orgId)).toBe('active');
    expect(
      (
        await all(
          kit.env.DB,
          "SELECT 1 FROM audit_log WHERE action = 'developer_sandbox.reset' AND org_id = ?",
          [newer.orgId],
        )
      ).length,
    ).toBe(0);
  });

  it('a create retried after its sandbox was deleted starts a new org instead of reusing the old id', async () => {
    const p = await person();
    // A create that failed, whose half-made sandbox the person then deleted.
    await blockTemplates(true);
    let failed: OperationDto;
    try {
      failed = await startAndSettle(send, p.headers, 'POST', '/developer/sandbox', {
        turnstileToken: 'ok',
      });
    } finally {
      await blockTemplates(false);
    }
    await startAndSettle(send, p.headers, 'DELETE', '/developer/sandbox');
    const res = await send('POST', `/operations/${failed.id}/retry`, p.headers);
    expect(res.status).toBe(202);
    await runJob({ kind: 'operation.run', operationId: failed.id, attempt: 2 });
    const done = await getOp(p.headers, failed.id);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.result?.ids.orgId).not.toBe(failed.target?.id);
  });
});

describe('one start per key (M1, L1)', () => {
  it('two concurrent resets with one Idempotency-Key run once and answer one operation', async () => {
    const s = await sandboxOf();
    // A pass first: the purge reads the credential keyset the first pass makes.
    const key = { authorization: `Bearer ${s.made.key?.secret}` };
    const detail = await send('GET', `/templates/${s.made.templateId}`, key);
    const sample = ((await detail.json()) as { manifest: { sample?: Record<string, unknown> } })
      .manifest.sample;
    const pass = await send('POST', '/passes', key, {
      templateId: s.made.templateId,
      input: sample ?? {},
    });
    expect(pass.status, await pass.clone().text()).toBe(201);
    const body = { turnstileToken: 'ok' };
    const [a, b] = await Promise.all([
      send('POST', '/developer/sandbox/reset', s.headers, body, 'same-key'),
      send('POST', '/developer/sandbox/reset', s.headers, body, 'same-key'),
    ]);
    const ids = [a, b].map(
      async (r) => ((await r.json()) as { operation: OperationDto }).operation.id,
    );
    const [ia, ib] = await Promise.all(ids);
    expect(ia).toBe(ib);
    const done = await settle(send, s.headers, ia as string);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const claims = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'developer_sandbox.reset' AND org_id = ?",
      [s.made.orgId],
    );
    expect(claims?.n).toBe(1);
  });

  it('answers a replay of a finished delete with its operation, not a 404', async () => {
    const s = await sandboxOf();
    const first1 = await send('DELETE', '/developer/sandbox', s.headers, undefined, 'del-key');
    const a = ((await first1.json()) as { operation: OperationDto }).operation;
    await settle(send, s.headers, a.id);
    const again = await send('DELETE', '/developer/sandbox', s.headers, undefined, 'del-key');
    expect(again.status).toBe(202);
    expect(((await again.json()) as { operation: OperationDto }).operation.id).toBe(a.id);
    expect(await deletesOf(s.user.id)).toBe(1);
  });
});

describe('a retry never starts a second purge (M2, M5)', () => {
  it('names the purge for the operation and attempt, never the day’s sweep', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'DELETE', '/developer/sandbox');
    const stored = await first<{ workflow_instance_id: string }>(
      kit.env.DB,
      'SELECT workflow_instance_id FROM operations WHERE id = ?',
      [op.id],
    );
    expect(stored?.workflow_instance_id).toBe(`${op.id}-r1`);
    expect(purges).toHaveBeenCalledWith(expect.objectContaining({ id: `${op.id}-r1` }));
  });

  it('refuses the retry while the earlier purge lives, and lets it go once it has ended', async () => {
    const s = await sandboxOf();
    const op = await startAndSettle(send, s.headers, 'DELETE', '/developer/sandbox');
    await run(
      kit.env.DB,
      `UPDATE operations SET status = 'failed', error_code = 'OPERATION_STALLED', error_step = 'passes',
         error_retryable = 1, finished_at = ? WHERE id = ?`,
      [kit.clock.now(), op.id],
    );
    purgeStatus = async () => ({ status: 'running' });
    await expectProblem(
      await send('POST', `/operations/${op.id}/retry`, s.headers),
      409,
      'OPERATION_RUNNING',
    );
    purgeStatus = async () => {
      throw new Error('socket closed');
    };
    await expectProblem(
      await send('POST', `/operations/${op.id}/retry`, s.headers),
      409,
      'OPERATION_RUNNING',
    );
    purgeStatus = async () => ({ status: 'errored' });
    const res = await send('POST', `/operations/${op.id}/retry`, s.headers);
    expect(res.status, await res.clone().text()).toBe(202);
    purgeStatus = null;
  });
});

describe('a retry after a step-up (M3, L3)', () => {
  it('works from the person’s new session, and not from a weak one', async () => {
    const s = await sandboxOf();
    const failed = await failDelete(s.headers);
    // The step-up signs in again and revokes the session that started the operation.
    const second = await makeSession(kit.f, {
      userId: s.user.id,
      roles: ['user', 'developer'],
      amr: 'oidc',
    });
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      await sha256Hex(s.session.cookieValue),
    ]);
    const weak = await makeSession(kit.f, {
      userId: s.user.id,
      roles: ['user', 'developer'],
      amr: 'magic_link',
    });
    expect((await send('POST', `/operations/${failed.id}/retry`, weak.headers)).status).toBe(403);
    const res = await send('POST', `/operations/${failed.id}/retry`, second.headers);
    expect(res.status, await res.clone().text()).toBe(202);
    const stored = await first<{ actor_session: string }>(
      kit.env.DB,
      'SELECT actor_session FROM operations WHERE id = ?',
      [failed.id],
    );
    expect(stored?.actor_session).toBe(await sha256Hex(second.cookieValue));
    expect((await settle(send, second.headers, failed.id)).status).toBe('succeeded');
  });

  it('is refused for a person who lost developer access', async () => {
    const s = await sandboxOf();
    const failed = await failDelete(s.headers);
    const plain = await makeSession(kit.f, { userId: s.user.id, roles: ['user'], amr: 'oidc' });
    await expectProblem(
      await send('POST', `/operations/${failed.id}/retry`, plain.headers),
      403,
      'DEVELOPER_ACCESS_REQUIRED',
    );
  });
});

describe('the stall resend (L4)', () => {
  it('expires the lease but keeps its owner, so a live old runner stays fenced out', async () => {
    const p = await person();
    const op = await startOperation(createServiceContext(kit.env, { clock: kit.clock }), {
      kind: 'sandbox.create',
      actor: { type: 'user', id: p.user.id },
      session: await sha256Hex(p.session.cookieValue),
      subject: { userId: p.user.id },
      lease: true,
    });
    await run(kit.env.DB, "UPDATE operations SET lease_owner = 'tok' WHERE id = ?", [op.id]);
    expect(await markResent(kit.env.DB, op.id, 1, 0, kit.clock.now())).toBe(true);
    const row = await first<{ lease_owner: string | null; lease_until: number | null }>(
      kit.env.DB,
      'SELECT lease_owner, lease_until FROM operations WHERE id = ?',
      [op.id],
    );
    expect(row).toEqual({ lease_owner: 'tok', lease_until: null });
  });
});

describe('the operations table and a developer org (L6)', () => {
  it('a Live operation of a developer org is unreadable, a Test one is readable', async () => {
    const { registerTestKinds, ORG_KIND } = await import(
      '../operations/operations-test-fixtures.ts'
    );
    const undo = registerTestKinds();
    try {
      const s = await sandboxOf();
      const ctx = createServiceContext(kit.env, { clock: kit.clock });
      const mk = (mode: 'live' | 'test') =>
        startOperation(ctx, {
          kind: ORG_KIND.kind,
          org: { orgId: s.made.orgId, mode },
          actor: { type: 'user', id: s.user.id },
          subject: { k: mode },
        });
      const live = await mk('live');
      const test = await mk('test');
      expect((await send('GET', `/operations/${live.id}`, s.headers)).status).toBe(404);
      const asTest = { ...s.headers, 'x-passbook-mode': 'test' };
      expect((await send('GET', `/operations/${test.id}`, asTest)).status).toBe(200);
    } finally {
      undo();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { registerTestKinds } from '../operations/operations-test-fixtures.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
let undo: () => void;
beforeAll(async () => {
  t = await workbenchKit();
  undo = registerTestKinds();
});
afterAll(() => {
  undo();
  vi.unstubAllGlobals();
});

const STEPS = JSON.stringify([{ key: 'a', state: 'pending' }]);

/** A starter row as `startOperation` writes it: no org or mode, the sandbox as its target. */
async function starter(
  id: string,
  row: {
    kind: string;
    actorId: string;
    actorSession: string;
    target?: string;
    audience?: 'starter' | 'platform';
    orgId?: string;
    mode?: 'live' | 'test';
  },
) {
  const now = t.kit.clock.now();
  const audience = row.audience ?? 'starter';
  await run(
    t.kit.env.DB,
    `INSERT INTO operations (id, kind, audience, org_id, mode, target_type, target_id, steps, status,
       actor_type, actor_id, actor_session, error_retryable, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', 'user', ?, ?, 1, ?, ?)`,
    [
      id,
      row.kind,
      audience,
      row.orgId ?? null,
      row.mode ?? null,
      row.target ? 'sandbox' : null,
      row.target ?? null,
      STEPS,
      row.actorId,
      audience === 'starter' ? row.actorSession : null,
      now,
      now,
    ],
  );
  return id;
}

describe('operations under a sandbox token: its owner’s sandbox rows', () => {
  it('lists and reads the sandbox create, reset and delete rows; nothing of another org, person or audience', async () => {
    const d = await t.developer();
    const other = await t.developer();
    const m = await t.member();
    const hash = await sha256Hex(d.session.cookieValue);
    const me = { actorId: d.user.id, actorSession: hash };
    const sandbox = d.made.orgId;
    const mine = {
      create: await starter(`sb-create-${sandbox}`, {
        kind: 'sandbox.create',
        target: sandbox,
        ...me,
      }),
      reset: await starter(`sb-reset-${sandbox}`, {
        kind: 'sandbox.reset',
        target: sandbox,
        ...me,
      }),
      del: await starter(`sb-delete-${sandbox}`, {
        kind: 'sandbox.delete',
        target: sandbox,
        ...me,
      }),
    };
    const hidden = {
      // The person's sandbox row for another org, and a starter row with no sandbox.
      otherOrg: await starter(`sb-o-${sandbox}`, {
        kind: 'sandbox.reset',
        target: m.orgId,
        ...me,
      }),
      noTarget: await starter(`sb-n-${sandbox}`, { kind: 'test.starter', ...me }),
      // Another person's row for this sandbox, and another sandbox's own row.
      theirs: await starter(`sb-t-${sandbox}`, {
        kind: 'sandbox.reset',
        target: sandbox,
        actorId: other.user.id,
        actorSession: await sha256Hex(other.session.cookieValue),
      }),
      theirSandbox: await starter(`sb-s-${sandbox}`, {
        kind: 'sandbox.reset',
        target: other.made.orgId,
        actorId: other.user.id,
        actorSession: await sha256Hex(other.session.cookieValue),
      }),
      // Org rows (Live and Test) of the sandbox and a platform row.
      orgLive: await starter(`sb-l-${sandbox}`, {
        kind: 'test.org',
        orgId: sandbox,
        mode: 'live',
        ...me,
      }),
      platform: await starter(`sb-p-${sandbox}`, {
        kind: 'test.platform',
        audience: 'platform',
        ...me,
      }),
    };
    const { token } = await t.wbMint(d.browser, sandbox);
    const client = t.asClient(token);
    const res = await t.call('GET', '/operations', client);
    expect(res.status, await res.clone().text()).toBe(200);
    const listed = ((await res.json()) as { items: { id: string }[] }).items.map((o) => o.id);
    for (const id of Object.values(mine)) expect(listed, id).toContain(id);
    for (const id of Object.values(hidden)) expect(listed, id).not.toContain(id);
    for (const id of Object.values(mine))
      expect((await t.call('GET', `/operations/${id}`, client)).status, id).toBe(200);
    for (const id of Object.values(hidden))
      expect((await t.call('GET', `/operations/${id}`, client)).status, id).toBe(404);
    // Rows outside the fence stay not found, whatever the verb. These go first: retrying the delete row
    // below deletes the sandbox in the background and revokes this token.
    for (const id of Object.values(hidden))
      for (const verb of ['retry', 'cancel'])
        expect((await t.call('POST', `/operations/${id}/${verb}`, client, {})).status, id).toBe(
          404,
        );
    // The sandbox kinds declare `tokenActs`: the token stops and retries them on its own sandbox rows.
    for (const id of Object.values(mine)) {
      const retry = await t.call('POST', `/operations/${id}/retry`, client, {});
      expect(retry.status, `retry ${id} ${await retry.clone().text()}`).not.toBe(403);
      expect(retry.status, `retry ${id}`).not.toBe(404);
    }
    // A delete retry that passes the rate limit starts a real purge workflow: let it end here, so nothing
    // outlives the file (the rate limit decides whether one starts).
    const row = await first<{ workflow_instance_id: string | null }>(
      t.kit.env.DB,
      'SELECT workflow_instance_id FROM operations WHERE id = ?',
      [mine.del],
    );
    if (row?.workflow_instance_id) {
      const purge = await t.kit.env.ORG_PURGE.get(row.workflow_instance_id);
      const ended = ['complete', 'errored', 'terminated'];
      let status = (await purge.status()).status;
      for (let i = 0; i < 800 && !ended.includes(status); i++) {
        await new Promise((r) => setTimeout(r, 25));
        status = (await purge.status()).status;
      }
      expect(ended, 'purge workflow left running').toContain(status);
    }
  });

  it('stops and retries only a kind that declares tokenActs, even on its own sandbox row', async () => {
    const d = await t.developer();
    const sandbox = d.made.orgId;
    const me = { actorId: d.user.id, actorSession: await sha256Hex(d.session.cookieValue) };
    // `test.starter` does not declare tokenActs; a row of it that targets the sandbox is in the fence.
    const plain = await starter(`sb-plain-${sandbox}`, {
      kind: 'test.starter',
      target: sandbox,
      ...me,
    });
    const { token } = await t.wbMint(d.browser, sandbox);
    const client = t.asClient(token);
    const read = await t.call('GET', `/operations/${plain}`, client);
    expect(read.status).toBe(200);
    const dto = (await read.json()) as {
      cancelable: boolean;
      error: { retryable: boolean } | null;
    };
    expect(dto.cancelable).toBe(false);
    expect(dto.error?.retryable ?? false).toBe(false);
    for (const verb of ['retry', 'cancel']) {
      const res = await t.call('POST', `/operations/${plain}/${verb}`, client, {});
      expect(res.status, verb).toBe(403);
      expect(((await res.json()) as { code: string }).code, verb).toBe('WORKBENCH_TEST_ONLY');
    }
  });

  it('retries a step-up sandbox kind only while its session would pass the step-up', async () => {
    const d = await t.developer();
    const sandbox = d.made.orgId;
    const me = { actorId: d.user.id, actorSession: await sha256Hex(d.session.cookieValue) };
    const id = await starter(`sb-stale-${sandbox}`, {
      kind: 'sandbox.reset',
      target: sandbox,
      ...me,
    });
    const { token } = await t.wbMint(d.browser, sandbox);
    const client = t.asClient(token);
    const fresh = await t.call('POST', `/operations/${id}/retry`, client, {});
    expect(fresh.status, await fresh.clone().text()).not.toBe(403);
    // Eleven minutes after sign-in the session is asked to sign in again, and so is its token.
    await run(
      t.kit.env.DB,
      "UPDATE operations SET status = 'failed', error_retryable = 1 WHERE id = ?",
      [id],
    );
    t.kit.clock.set(t.kit.clock.now() + 11 * 60_000);
    const stale = await t.call('POST', `/operations/${id}/retry`, client, {});
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
    const cancel = await t.call('POST', `/operations/${id}/cancel`, client, {});
    expect(cancel.status).toBe(403);
    expect(((await cancel.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
  });
});

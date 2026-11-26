import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../../platform/db.ts';
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

describe('operations under a sandbox token: its owner’s sandbox rows, read only', () => {
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
    // Read only: no stop, no retry.
    for (const id of Object.values(mine))
      for (const verb of ['retry', 'cancel'])
        expect((await t.call('POST', `/operations/${id}/${verb}`, client, {})).status, id).toBe(
          403,
        );
  });
});

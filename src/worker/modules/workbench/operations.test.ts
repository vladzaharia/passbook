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

/** An operation row as the store writes it. */
async function op(
  id: string,
  row: {
    kind: string;
    audience: 'org' | 'starter';
    orgId: string | null;
    mode: 'live' | 'test' | null;
    actorId?: string;
    actorSession?: string;
  },
) {
  const now = t.kit.clock.now();
  await run(
    t.kit.env.DB,
    `INSERT INTO operations (id, kind, audience, org_id, mode, steps, status, actor_type, actor_id,
       actor_session, error_retryable, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'failed', 'user', ?, ?, 1, ?, ?)`,
    [
      id,
      row.kind,
      row.audience,
      row.orgId,
      row.mode,
      STEPS,
      row.actorId ?? null,
      row.actorSession ?? null,
      now,
      now,
    ],
  );
  return id;
}

describe('operations under a member token: its org, Test, what the person may see', () => {
  it("lists and reads only the pinned org's Test rows; other orgs and Live starter rows are invisible", async () => {
    const a = await t.member();
    const b = await t.member();
    await t.join(a.user.id, b.orgId, ['org_admin']);
    const hash = await sha256Hex(a.session.cookieValue);
    const me = { actorId: a.user.id, actorSession: hash };
    const ids = {
      aTest: await op(`op-a-test-${a.orgId}`, {
        kind: 'test.org',
        audience: 'org',
        orgId: a.orgId,
        mode: 'test',
      }),
      aLive: await op(`op-a-live-${a.orgId}`, {
        kind: 'test.org',
        audience: 'org',
        orgId: a.orgId,
        mode: 'live',
      }),
      bTest: await op(`op-b-test-${a.orgId}`, {
        kind: 'test.org',
        audience: 'org',
        orgId: b.orgId,
        mode: 'test',
      }),
      starterLive: await op(`op-s-live-${a.orgId}`, {
        kind: 'test.starter',
        audience: 'starter',
        orgId: a.orgId,
        mode: 'live',
        ...me,
      }),
      starterNone: await op(`op-s-none-${a.orgId}`, {
        kind: 'test.starter',
        audience: 'starter',
        orgId: null,
        mode: null,
        ...me,
      }),
      starterOther: await op(`op-s-b-${a.orgId}`, {
        kind: 'test.starter',
        audience: 'starter',
        orgId: b.orgId,
        mode: 'test',
        ...me,
      }),
      starterTest: await op(`op-s-test-${a.orgId}`, {
        kind: 'test.starter',
        audience: 'starter',
        orgId: a.orgId,
        mode: 'test',
        ...me,
      }),
    };
    // The person's cookie session (admin, Test mode) sees their other orgs and starter rows: the token must not.
    const session = await t.call('GET', `/operations?orgId=${b.orgId}`, {
      ...a.browser,
      'x-passbook-mode': 'test',
    });
    expect(
      ((await session.json()) as { items: { id: string }[] }).items.map((o) => o.id),
    ).toContain(ids.bTest);

    const { token } = await t.wbMint(a.browser, a.orgId);
    const client = t.asClient(token);
    const listed = async (path: string) => {
      const res = await t.call('GET', path, client);
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { items: { id: string }[] }).items.map((o) => o.id).sort();
    };
    expect(await listed('/operations')).toEqual([ids.aTest, ids.starterTest].sort());
    expect(await listed(`/operations?orgId=${b.orgId}`)).toEqual([ids.starterTest]);
    for (const id of [ids.aLive, ids.bTest, ids.starterLive, ids.starterNone, ids.starterOther]) {
      expect((await t.call('GET', `/operations/${id}`, client)).status, id).toBe(404);
      expect((await t.call('POST', `/operations/${id}/retry`, client, {})).status, id).toBe(404);
      expect((await t.call('POST', `/operations/${id}/cancel`, client, {})).status, id).toBe(404);
    }
    expect((await t.call('GET', `/operations/${ids.aTest}`, client)).status).toBe(200);
    const retried = await t.call('POST', `/operations/${ids.aTest}/retry`, client, {});
    expect(retried.status, await retried.clone().text()).toBeLessThan(300);
  });
});

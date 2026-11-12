import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { BroadcastListSchema, BroadcastSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { startDueBroadcasts } from './start.ts';
import { type BroadcastAuth, type BroadcastKit, broadcastAuth, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
let auth: BroadcastAuth;
let kit: BroadcastKit;
let app: ReturnType<typeof createApp>;
let other: { id: string };

beforeAll(async () => {
  kit = await broadcastKit();
  auth = await broadcastAuth(kit, ORIGIN);
  app = createApp({ stores: auth.stores });
  other = await makeOrg(kit.fx, { name: 'Other Org' });
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const post = (path: string, headers: Headers, body: unknown = {}) =>
  api(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const message = (text: string, extra: Record<string, unknown> = {}) => ({
  orgId: kit.org.id,
  kind: 'message',
  target: { templateIds: [kit.messaging.id] },
  patch: { message: text },
  ...extra,
});
const dto = async (res: Response) => BroadcastSchema.parse(await res.json());
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

type Step = Parameters<typeof runBroadcast>[3];
const stepRun: Step = {
  do: async (_n: string, a: unknown, b?: unknown) =>
    await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Step;

/** Creates a broadcast and runs its Workflow instance inline. */
async function sendNow(body: Record<string, unknown>, headers: Headers = auth.admin()) {
  const before = kit.broadcast.created.length;
  const res = await post('/broadcasts', headers, body);
  expect(res.status).toBe(201);
  const created = await dto(res);
  const instance = kit.broadcast.created.at(before);
  expect(instance?.id).toBe(`broadcast-${created.id}`);
  await runBroadcast(kit.env, instance?.id ?? '', { broadcastId: created.id }, stepRun, undefined);
  await kit.settle();
  return dto(await api(`/broadcasts/${created.id}`, { headers }));
}

describe('send now', () => {
  it('updates the targeted passes and counts them', async () => {
    const a = await kit.makePass();
    const b = await kit.makePass();
    const voided = await kit.makePass();
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    const removed = await kit.makePass();
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    const plain = await kit.makePass({ templateId: kit.plain.id });
    const test = await kit.makePass({ mode: 'test' });

    const done = await sendNow(message('Doors open at 7'));
    expect(done.state).toBe('sent');
    expect(done.counts).toMatchObject({ updated: 2, unchanged: 0, failed: 0, overBudget: 0 });
    expect(done.counts.targeted).toBeGreaterThanOrEqual(2);
    for (const pass of [a, b]) {
      const row = await getPass(kit.env.DB, pass.id, null);
      expect(row?.personalization.message).toBe('Doors open at 7');
      expect(row?.version).toBe(2);
    }
    for (const pass of [voided, removed, plain, test]) {
      const row = await getPass(kit.env.DB, pass.id, null);
      expect(row?.version, pass.id).toBe(1);
    }
    const events = await all<{ kind: string; data: string }>(
      kit.env.DB,
      `SELECT kind, data FROM pass_events WHERE pass_id = ? AND kind IN ('message.applied', 'pass.updated')`,
      [a.id],
    );
    expect(events.map((e) => e.kind).sort()).toEqual(['message.applied', 'pass.updated']);
    expect(JSON.parse(events.find((e) => e.kind === 'pass.updated')?.data ?? '{}')).toMatchObject({
      source: 'broadcast',
      notified: true,
    });
    const versions = await first<{ source: string }>(
      kit.env.DB,
      'SELECT source FROM pass_versions WHERE pass_id = ? AND version = 2',
      [a.id],
    );
    expect(versions?.source).toBe('broadcast');
    const wf = await first<{ kind: string; status: string }>(
      kit.env.DB,
      'SELECT kind, status FROM workflow_runs WHERE instance_id = ?',
      [`broadcast-${done.id}`],
    );
    expect(wf).toEqual({ kind: 'broadcast', status: 'complete' });
  });

  it('is idempotent: a second run, or an identical message, changes nothing', async () => {
    const a = await kit.makePass();
    const first = await sendNow(
      message('Same text', { target: { templateIds: [kit.messaging.id], q: 'Alex' } }),
    );
    expect(first.counts.updated).toBeGreaterThanOrEqual(1);
    const again = await runBroadcast(
      kit.env,
      `broadcast-${first.id}`,
      { broadcastId: first.id },
      stepRun,
    );
    expect(again.state).toBe('skipped');
    const second = await sendNow(message('Same text'));
    expect(second.counts.updated).toBe(0);
    expect(second.counts.unchanged).toBeGreaterThanOrEqual(1);
    expect((await getPass(kit.env.DB, a.id, null))?.version).toBe(2);
  });

  it('updates silently past the push budget and counts it', async () => {
    const pass = await kit.makePass({ gate: 'X' });
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id != ? AND template_id = ?", [
      pass.id,
      kit.messaging.id,
    ]);
    for (const text of ['one', 'two', 'three']) await sendNow(message(text));
    const preview = await dto(
      await post('/broadcasts', auth.admin(), message('four', { send: 'draft' })),
    );
    expect(preview.state).toBe('draft');
    const pre = await post('/broadcasts/preview', auth.admin(), {
      orgId: kit.org.id,
      target: { templateIds: [kit.messaging.id] },
    });
    expect(await pre.json()).toMatchObject({ targeted: 1, overBudget: 1, limit: 3 });
    const four = await sendNow(message('four'));
    expect(four.counts).toMatchObject({ updated: 1, overBudget: 1 });
  });

  it('clearing is silent and a follow-up clears only the text it set', async () => {
    const a = await kit.makePass({ templateId: kit.messaging.id });
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id != ? AND template_id = ?", [
      a.id,
      kit.messaging.id,
    ]);
    const sent = await sendNow(message('Back at 3', { clearAfter: 3_600_000 }));
    expect(sent.counts.updated).toBe(1);
    const follow = await first<{ id: string; state: string; at: number; notify: number }>(
      kit.env.DB,
      'SELECT id, state, at, notify FROM broadcasts WHERE parent_id = ?',
      [sent.id],
    );
    expect(follow).toMatchObject({ state: 'scheduled', notify: 0 });
    // A newer message replaced it: the follow-up leaves that one alone.
    await sendNow(message('Newer text'));
    kit.clock.advance(3_700_000);
    await startDueBroadcasts(jobCtxOf(kit));
    const instance = kit.broadcast.created.at(-1);
    expect(instance?.id).toBe(`broadcast-${follow?.id}`);
    await runBroadcast(kit.env, instance?.id ?? '', { broadcastId: follow?.id ?? '' }, stepRun);
    const cleared = await dto(await api(`/broadcasts/${follow?.id}`, { headers: auth.admin() }));
    expect(cleared).toMatchObject({ state: 'sent', parentId: sent.id });
    expect(cleared.counts).toMatchObject({ updated: 0, unchanged: 1 });
    expect((await getPass(kit.env.DB, a.id, null))?.personalization.message).toBe('Newer text');
    // Clearing the current text is silent.
    const clear = await sendNow(message(''));
    expect(clear.counts).toMatchObject({ updated: 1 });
    const last = await first<{ data: string }>(
      kit.env.DB,
      `SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated' ORDER BY at DESC, id DESC`,
      [a.id],
    );
    expect(JSON.parse(last?.data ?? '{}')).toMatchObject({ notified: false });
  });
});

describe('schedule', () => {
  it('starts once however many ticks race, and cancel stops it', async () => {
    const at = kit.clock.now() + 600_000;
    const res = await post('/broadcasts', auth.admin(), message('Later', { send: 'schedule', at }));
    const scheduled = await dto(res);
    expect(scheduled).toMatchObject({ state: 'scheduled', at });
    const before = kit.broadcast.created.length;
    await startDueBroadcasts(jobCtxOf(kit));
    expect(kit.broadcast.created).toHaveLength(before);
    kit.clock.advance(601_000);
    await Promise.all([startDueBroadcasts(jobCtxOf(kit)), startDueBroadcasts(jobCtxOf(kit))]);
    const mine = kit.broadcast.created.filter((c) => c.id === `broadcast-${scheduled.id}`);
    expect(mine).toHaveLength(1);
    const running = await dto(await api(`/broadcasts/${scheduled.id}`, { headers: auth.admin() }));
    expect(running.state).toBe('sending');
    const cancel = await post(`/broadcasts/${scheduled.id}/cancel`, auth.admin());
    expect(cancel.status).toBe(409);
    expect(await code(cancel)).toBe('BROADCAST_NOT_CANCELLABLE');

    const another = await dto(
      await post(
        '/broadcasts',
        auth.admin(),
        message('Never', { send: 'schedule', at: kit.clock.now() + 60_000 }),
      ),
    );
    const cancelled = await dto(await post(`/broadcasts/${another.id}/cancel`, auth.admin()));
    expect(cancelled.state).toBe('cancelled');
    kit.clock.advance(120_000);
    const n = kit.broadcast.created.length;
    await startDueBroadcasts(jobCtxOf(kit));
    expect(kit.broadcast.created).toHaveLength(n);
  });

  it('puts the workflow start back to scheduled when it fails', async () => {
    const res = await post('/broadcasts', auth.admin(), message('Retry', { send: 'draft' }));
    const draft = await dto(res);
    const original = kit.broadcast.create;
    kit.broadcast.create = async () => {
      throw new Error('workflow down');
    };
    const sent = await dto(await post(`/broadcasts/${draft.id}/send`, auth.admin()));
    kit.broadcast.create = original;
    expect(sent.state).toBe('scheduled');
    await startDueBroadcasts(jobCtxOf(kit));
    expect((await dto(await api(`/broadcasts/${draft.id}`, { headers: auth.admin() }))).state).toBe(
      'sending',
    );
  });

  it('refuses a time in the past', async () => {
    const res = await post(
      '/broadcasts',
      auth.admin(),
      message('Old', { send: 'schedule', at: 1000 }),
    );
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('BROADCAST_PAST');
  });
});

describe('validation', () => {
  it('needs a template with a message field', async () => {
    const res = await post(
      '/broadcasts',
      auth.admin(),
      message('x', { target: { templateIds: [kit.plain.id] } }),
    );
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('MESSAGING_UNSUPPORTED');
  });

  it('checks a scheduled change against the template inputs', async () => {
    const bad = await post('/broadcasts', auth.admin(), {
      orgId: kit.org.id,
      kind: 'change',
      target: { templateIds: [kit.messaging.id] },
      patch: { nope: 'x' },
    });
    expect(await code(bad)).toBe('BROADCAST_UNKNOWN_INPUT');
    const pass = await kit.makePass({ gate: 'G1' });
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id != ? AND template_id = ?", [
      pass.id,
      kit.messaging.id,
    ]);
    const done = await sendNow({
      orgId: kit.org.id,
      kind: 'change',
      target: { templateIds: [kit.messaging.id] },
      patch: { gate: 'G9' },
    });
    expect(done.counts.updated).toBe(1);
    const row = await getPass(kit.env.DB, pass.id, null);
    expect(row?.personalization.gate).toBe('G9');
    const event = await first<{ id: string }>(
      kit.env.DB,
      `SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'schedule.applied'`,
      [pass.id],
    );
    expect(event).not.toBeNull();
  });

  it('rejects a change value the input schema refuses', async () => {
    const res = await post('/broadcasts', auth.admin(), {
      orgId: kit.org.id,
      kind: 'change',
      target: { templateIds: [kit.messaging.id] },
      patch: { gate: 'x'.repeat(30) },
    });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('BROADCAST_INVALID_INPUT');
  });

  it('keeps a message under 256 characters', async () => {
    expect((await post('/broadcasts', auth.admin(), message('x'.repeat(257)))).status).toBe(422);
  });
});

describe('tenant, mode and scope isolation', () => {
  it('another org: 403 on create and preview, 404 on read and cancel', async () => {
    const created = await dto(
      await post('/broadcasts', auth.admin(), message('Mine', { send: 'draft' })),
    );
    const key = await auth.apiKey({ orgId: other.id, scopes: ['messages:write'] });
    expect((await post('/broadcasts', key, message('Theirs'))).status).toBe(403);
    expect(
      (
        await post('/broadcasts/preview', key, {
          orgId: kit.org.id,
          target: { templateIds: [kit.messaging.id] },
        })
      ).status,
    ).toBe(403);
    expect((await api(`/broadcasts/${created.id}`, { headers: key })).status).toBe(404);
    expect((await post(`/broadcasts/${created.id}/cancel`, key)).status).toBe(404);
    expect((await post(`/broadcasts/${created.id}/send`, key)).status).toBe(404);
    const list = BroadcastListSchema.parse(
      await (await api('/broadcasts', { headers: key })).json(),
    );
    expect(list.items).toEqual([]);
  });

  it('a test caller sees test broadcasts only in lists, and its targets are test passes', async () => {
    const live = await dto(
      await post('/broadcasts', auth.admin(), message('Live one', { send: 'draft' })),
    );
    const testAdmin = auth.admin({ mode: 'test' });
    const test = await dto(
      await post('/broadcasts', testAdmin, message('Test one', { send: 'draft' })),
    );
    expect(test.mode).toBe('test');
    const ids = async (headers: Headers) =>
      BroadcastListSchema.parse(
        await (await api(`/broadcasts?orgId=${kit.org.id}&limit=200`, { headers })).json(),
      ).items.map((b) => b.id);
    expect(await ids(auth.admin())).toContain(live.id);
    expect(await ids(auth.admin())).not.toContain(test.id);
    expect(await ids(testAdmin)).toContain(test.id);
    expect(await ids(testAdmin)).not.toContain(live.id);
    // Get by id works in either mode.
    expect((await api(`/broadcasts/${test.id}`, { headers: auth.admin() })).status).toBe(200);
    const testPass = await kit.makePass({ mode: 'test' });
    const count = async (headers: Headers) =>
      (await (
        await post('/broadcasts/preview', headers, {
          orgId: kit.org.id,
          target: { templateIds: [kit.messaging.id], q: 'Alex' },
        })
      ).json()) as { targeted: number };
    expect((await count(testAdmin)).targeted).toBe(1);
    expect(testPass.mode).toBe('test');
  });

  it('a test key cannot read, send or cancel a live broadcast; a Test session gets MODE_MISMATCH', async () => {
    const live = await dto(
      await post('/broadcasts', auth.admin(), message('Live draft', { send: 'draft' })),
    );
    const key = await auth.apiKey({ orgId: kit.org.id, mode: 'test', scopes: ['messages:write'] });
    expect((await api(`/broadcasts/${live.id}`, { headers: key })).status).toBe(404);
    expect((await post(`/broadcasts/${live.id}/send`, key)).status).toBe(404);
    expect((await post(`/broadcasts/${live.id}/cancel`, key)).status).toBe(404);
    const testAdmin = auth.admin({ mode: 'test' });
    for (const action of ['send', 'cancel']) {
      const res = await post(`/broadcasts/${live.id}/${action}`, testAdmin);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('MODE_MISMATCH');
    }
    expect((await dto(await api(`/broadcasts/${live.id}`, { headers: auth.admin() }))).state).toBe(
      'draft',
    );
    expect(kit.broadcast.created.some((i) => i.id === `broadcast-${live.id}`)).toBe(false);
  });

  it('a change also needs passes:write', async () => {
    const change = {
      orgId: kit.org.id,
      kind: 'change',
      target: { templateIds: [kit.messaging.id] },
      patch: { gate: 'Z1' },
    };
    const only = await auth.apiKey({ orgId: kit.org.id, scopes: ['messages:write'] });
    const denied = await post('/broadcasts', only, change);
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('MISSING_SCOPE');
    const both = await auth.apiKey({
      orgId: kit.org.id,
      scopes: ['messages:write', 'passes:write'],
    });
    const draft = await dto(await post('/broadcasts', both, { ...change, send: 'draft' }));
    expect(
      (await post(`/broadcasts/${draft.id}/send`, only, { at: kit.clock.now() + 60_000 })).status,
    ).toBe(403);
    expect((await post(`/broadcasts/${draft.id}/cancel`, only)).status).toBe(200);
  });

  it('needs the messages:write scope', async () => {
    const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read', 'passes:write'] });
    expect((await api('/broadcasts', { headers: key })).status).toBe(403);
    expect((await post('/broadcasts', key, message('x'))).status).toBe(403);
    const ok = await auth.apiKey({ orgId: kit.org.id, scopes: ['messages:write'] });
    expect((await api('/broadcasts', { headers: ok })).status).toBe(200);
  });

  it('a signed-in holder cannot use it', async () => {
    expect((await api(`/broadcasts?orgId=${kit.org.id}`, { headers: auth.user() })).status).toBe(
      403,
    );
  });
});

it('previews and processes only passes checked in to the selected event', async () => {
  const arrived = await kit.makePass();
  const absent = await kit.makePass();
  const eventId = `event-${arrived.id}`;
  await run(
    kit.env.DB,
    `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
    VALUES (?, 'check_in', ?, ?, 'live', ?, 'check_in', 'in', 1, 1, 1, 'scan')`,
    [arrived.id, `event:${eventId}`, kit.org.id, kit.messaging.id],
  );
  const target = { templateIds: [kit.messaging.id], scan: { eventId, checkedIn: true } };
  const preview = await post('/broadcasts/preview', auth.admin(), { orgId: kit.org.id, target });
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ targeted: 1 });
  const done = await sendNow(message('Event update', { target }));
  expect(done.counts).toMatchObject({ targeted: 1, updated: 1 });
  expect((await getPass(kit.env.DB, arrived.id, null))?.personalization.message).toBe(
    'Event update',
  );
  expect((await getPass(kit.env.DB, absent.id, null))?.personalization.message).not.toBe(
    'Event update',
  );
});

import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChunk } from './apply.ts';
import { type ChangeKit, changeKit } from './change-fixtures.ts';
import { failStuckBroadcasts } from './start.ts';

let ck: ChangeKit;
beforeAll(async () => {
  ck = await changeKit();
});

const edit = (passId: string, values: Record<string, string>) =>
  publishPass(jobCtxOf(ck.kit), {
    passId,
    cause: 'admin',
    actor: { type: 'system', id: null },
    notify: false,
    mutate: (p) => ({ personalization: { ...p.personalization, ...values } }),
  });
const personalization = async (id: string) =>
  (await getPass(ck.kit.env.DB, id, null))?.personalization;
const undo = async (id: string, headers = ck.auth.admin()) =>
  ck.post(`/broadcasts/${id}/undo`, {}, headers);
const asked = async (id: string) => {
  const res = await undo(id);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; parentId: string; restorable: number; kept: number };
};
const run3 = async (notify = true) => {
  const passes = [
    await ck.kit.makePass({ gate: 'A' }),
    await ck.kit.makePass({ gate: 'A' }),
    await ck.kit.makePass({ gate: 'A' }),
  ];
  const done = await ck.change({
    target: { passIds: passes.map((p) => p.id) },
    patch: { gate: { set: 'B' } },
    notify,
  });
  return { passes, done };
};

describe('undo', () => {
  it("restores only what is still at the run's value, silently", async () => {
    const { passes, done } = await run3();
    const [a, b, c] = passes;
    if (!a || !b || !c) throw new Error('passes');
    await edit(b.id, { gate: 'Z' });
    await edit(c.id, { note: 'kept' });
    const ask = await asked(done.id);
    expect(ask).toMatchObject({ parentId: done.id, restorable: 3, kept: 0 });
    await ck.runNext();
    const child = await ck.get(ask.id);
    expect(child).toMatchObject({
      state: 'sent',
      kind: 'change',
      parentId: done.id,
      notify: false,
    });
    expect(child.counts).toMatchObject({ updated: 2, unchanged: 1, failed: 0 });
    expect((await personalization(a.id))?.gate).toBe('A');
    expect((await personalization(b.id))?.gate).toBe('Z');
    expect(await personalization(c.id)).toMatchObject({ gate: 'A', note: 'kept' });
    // Silent: the restore carries no change message and no event says it notified.
    const json = await first<{ pass_json: string }>(
      ck.kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [a.id],
    );
    expect(json?.pass_json).not.toContain('changeMessage');
    const events = await all<{ data: string }>(
      ck.kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated' ORDER BY at, id",
      [a.id],
    );
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ notified: false });
    expect(await asked(done.id)).toMatchObject({ id: ask.id, restorable: 2, kept: 1 });
  });

  it('asking again returns the same undo and starts nothing', async () => {
    const { done } = await run3(false);
    const before = ck.kit.broadcast.created.length;
    const first = await asked(done.id);
    const again = await asked(done.id);
    expect(again.id).toBe(first.id);
    expect(ck.kit.broadcast.created.length).toBe(before + 1);
    await ck.runNext();
    expect((await asked(done.id)).id).toBe(first.id);
    expect(ck.kit.broadcast.created.length).toBe(before + 1);
  });

  it('refuses an undo of an undo, of a message, of a running change and after 24 hours', async () => {
    const { done } = await run3(false);
    const ask = await asked(done.id);
    await ck.runNext();
    await expectProblem(await undo(ask.id), 409, 'BROADCAST_NOT_UNDOABLE');
    const msg = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'message',
      send: 'draft',
      target: { templateIds: [ck.kit.messaging.id] },
      patch: { message: 'Hi' },
    });
    await expectProblem(
      await undo(((await msg.json()) as { id: string }).id),
      409,
      'BROADCAST_NOT_UNDOABLE',
    );
    const pass = await ck.kit.makePass();
    const created = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'change',
      target: { passIds: [pass.id] },
      patch: { gate: 'Q' },
    });
    const running = (await created.json()) as { id: string; state: string };
    expect(running.state).toBe('sending');
    await expectProblem(await undo(running.id), 409, 'BROADCAST_NOT_UNDOABLE');
    await ck.runNext();
    const { done: old } = await run3(false);
    ck.kit.clock.advance(25 * 3_600_000);
    await expectProblem(await undo(old.id), 409, 'BROADCAST_UNDO_EXPIRED');
  });

  it('is tenant- and scope-checked', async () => {
    const { done } = await run3(false);
    const other = await makeOrg(ck.kit.fx, { name: 'Elsewhere' });
    const theirs = await ck.auth.apiKey({
      orgId: other.id,
      scopes: ['messages:write', 'passes:write'],
    });
    await expectProblem(await undo(done.id, theirs), 404, 'BROADCAST_NOT_FOUND');
    const noPass = await ck.auth.apiKey({ orgId: ck.kit.org.id, scopes: ['messages:write'] });
    await expectProblem(await undo(done.id, noPass), 403, 'MISSING_SCOPE');
    const readOnly = await ck.auth.apiKey({
      orgId: ck.kit.org.id,
      scopes: ['messages:read', 'passes:read'],
    });
    expect((await undo(done.id, readOnly)).status).toBe(403);
    const mine = await ck.auth.apiKey({
      orgId: ck.kit.org.id,
      scopes: ['messages:write', 'passes:write'],
    });
    expect((await undo(done.id, mine)).status).toBe(200);
  });

  it('an undo that ended on an error runs again as the same child, once', async () => {
    const { done } = await run3(false);
    const ask = await asked(done.id);
    await run(
      ck.kit.env.DB,
      "UPDATE broadcasts SET state = 'failed', error_code = 'BROADCAST_FAILED', finished_at = ? WHERE id = ?",
      [ck.kit.clock.now(), ask.id],
    );
    const before = ck.kit.broadcast.created.length;
    expect((await asked(done.id)).id).toBe(ask.id);
    expect(ck.kit.broadcast.created.length).toBe(before + 1);
    const instance = await first<{ instance: string; state: string }>(
      ck.kit.env.DB,
      'SELECT instance, state FROM broadcasts WHERE id = ?',
      [ask.id],
    );
    expect(instance?.instance).toMatch(new RegExp(`^broadcast-${ask.id}-`));
    expect(instance?.state).toBe('sending');
    // Running now: asking again starts nothing.
    expect((await asked(done.id)).id).toBe(ask.id);
    expect(ck.kit.broadcast.created.length).toBe(before + 1);
    await ck.runNext();
    expect((await ck.get(ask.id)).counts.updated).toBe(3);
  });
});

describe('stop', () => {
  it('ends a sending run after its chunk as cancelled, and the run can be undone', async () => {
    const passes = [
      await ck.kit.makePass({ gate: 'A' }),
      await ck.kit.makePass({ gate: 'A' }),
      await ck.kit.makePass({ gate: 'A' }),
    ];
    const res = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'change',
      target: { passIds: passes.map((p) => p.id) },
      patch: { gate: { set: 'B' } },
      notify: false,
    });
    const { id } = (await res.json()) as { id: string };
    const ctx = jobCtxOf(ck.kit);
    expect((await applyChunk(ctx, id, null, 2)).nextCursor).not.toBeNull();
    expect((await ck.post(`/broadcasts/${id}/stop`)).status).toBe(200);
    await ck.runNext();
    const stopped = await ck.get(id);
    expect(stopped).toMatchObject({ state: 'cancelled', errorCode: 'BROADCAST_STOPPED' });
    expect(stopped.counts.updated).toBe(2);
    await expectProblem(await ck.post(`/broadcasts/${id}/stop`), 409, 'BROADCAST_NOT_SENDING');
    expect((await asked(id)).restorable).toBe(2);
  });
});

describe('the creator is proved in every write', () => {
  it('a key revoked mid-run writes nothing more and ends the run failed', async () => {
    const pass = await ck.kit.makePass({ gate: 'A' });
    const key = await ck.auth.apiKey({
      orgId: ck.kit.org.id,
      scopes: ['messages:write', 'passes:write'],
    });
    const res = await ck.post(
      '/broadcasts',
      {
        orgId: ck.kit.org.id,
        kind: 'change',
        target: { passIds: [pass.id] },
        patch: { gate: 'B' },
      },
      key,
    );
    const { id } = (await res.json()) as { id: string };
    const row = await first<{ created_by_id: string }>(
      ck.kit.env.DB,
      'SELECT created_by_id FROM broadcasts WHERE id = ?',
      [id],
    );
    await run(ck.kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      ck.kit.clock.now(),
      row?.created_by_id ?? '',
    ]);
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect((await personalization(pass.id))?.gate).toBe('A');
    expect(await ck.get(id)).toMatchObject({ state: 'failed', errorCode: 'CREATOR_REVOKED' });
    expect(await ck.items(id)).toEqual([]);
  });
});

describe('a dead undo', () => {
  it('the sweeper ends it failed from its own instance, and the next ask restarts it once', async () => {
    const { done } = await run3(false);
    const ask = await asked(done.id);
    const seen: string[] = [];
    (ck.kit.env as unknown as { BROADCAST: Record<string, unknown> }).BROADCAST.get = async (
      id: string,
    ) => {
      seen.push(id);
      return { status: async () => ({ status: 'errored' }) };
    };
    ck.kit.clock.advance(10 * 60_000);
    await failStuckBroadcasts(jobCtxOf(ck.kit));
    expect(seen.filter((id) => id.includes(ask.id))).toEqual([`broadcast-${ask.id}`]);
    expect(await ck.get(ask.id)).toMatchObject({ state: 'failed', errorCode: 'BROADCAST_FAILED' });
    const before = ck.kit.broadcast.created.length;
    await asked(done.id);
    await asked(done.id);
    expect(ck.kit.broadcast.created.length).toBe(before + 1);
    seen.length = 0;
    ck.kit.clock.advance(10 * 60_000);
    await failStuckBroadcasts(jobCtxOf(ck.kit));
    expect(seen.filter((id) => id.includes(ask.id))[0]).toMatch(
      new RegExp(`^broadcast-${ask.id}-.+`),
    );
  });

  it('a change that was undone is not run again', async () => {
    const { done } = await run3(false);
    await run(
      ck.kit.env.DB,
      "UPDATE broadcasts SET state = 'failed', error_code = 'BROADCAST_FAILED' WHERE id = ?",
      [done.id],
    );
    await asked(done.id);
    await expectProblem(
      await ck.post(`/broadcasts/${done.id}/retry`),
      409,
      'BROADCAST_NOT_RETRYABLE',
    );
  });
});

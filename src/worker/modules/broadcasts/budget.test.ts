import { beforeAll, describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { pushBudgetOf } from '../passes/change-messages.ts';
import { getPassDetail } from '../passes/detail.ts';
import { publishPass } from '../passes/publish.ts';
import { currentPassJson, getPass } from '../passes/repo-read-pass.ts';
import { type BroadcastKit, broadcastKit } from './test-kit.ts';

let kit: BroadcastKit;
beforeAll(async () => {
  kit = await broadcastKit();
});

const actor = { type: 'system', id: null } as const;
const setGate = (passId: string, gate: string, notify = true) =>
  publishPass(jobCtxOf(kit), {
    passId,
    cause: 'admin',
    actor,
    notify,
    mutate: (p) => ({ personalization: { ...p.personalization, gate } }),
  });

const updates = (passId: string) =>
  all<{ data: string }>(
    kit.env.DB,
    `SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated' ORDER BY at, id`,
    [passId],
  ).then((rows) => rows.map((r) => JSON.parse(r.data) as Record<string, unknown>));

describe('push budget', () => {
  it('silences the update past the daily limit, in every source, until the window rolls', async () => {
    const pass = await kit.makePass({ gate: 'A1' });
    for (const gate of ['A2', 'A3', 'A4'])
      expect((await setGate(pass.id, gate)).silenced).toBeUndefined();
    expect(await pushBudgetOf(kit.ctx, pass.id)).toMatchObject({ used: 3, limit: 3 });

    // A connection-style publish (notify omitted) keeps the template's message; the budget strips it.
    const fourth = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'connection',
      actor,
      mutate: (p) => ({ personalization: { ...p.personalization, gate: 'A5' } }),
    });
    expect(fourth.changed).toBe(true);
    expect(fourth.silenced).toBe(true);
    expect(await currentPassJson(kit.env.DB, pass.id)).not.toContain('changeMessage');
    const events = await updates(pass.id);
    expect(events.at(-1)).toMatchObject({ notified: false, overBudget: true });
    expect(events.filter((e) => e.notified === true)).toHaveLength(3);

    const detail = await getPassDetail(kit.ctx, pass.id, null);
    expect(detail.pushBudget).toMatchObject({ used: 3, limit: 3 });
    expect(detail.pushBudget.resetsAt).toBeGreaterThan(kit.clock.now());

    kit.clock.advance(25 * 3_600_000);
    expect((await setGate(pass.id, 'A6')).silenced).toBeUndefined();
    expect((await updates(pass.id)).at(-1)).toMatchObject({ notified: true });
  });

  it('a silent save does not use the budget', async () => {
    const pass = await kit.makePass({ gate: 'B1' });
    for (const gate of ['B2', 'B3', 'B4', 'B5']) await setGate(pass.id, gate, false);
    expect((await pushBudgetOf(kit.ctx, pass.id)).used).toBe(0);
  });

  it('never pushes when pass.json is byte-identical', async () => {
    const pass = await kit.makePass({ gate: 'C1' });
    await setGate(pass.id, 'C2');
    const before = await updates(pass.id);
    const queued = () =>
      all<{ id: string }>(
        kit.env.DB,
        `SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'push.queued'`,
        [pass.id],
      );
    const pushes = (await queued()).length;
    const again = await setGate(pass.id, 'C2');
    expect(again.changed).toBe(false);
    expect(await updates(pass.id)).toHaveLength(before.length);
    expect(await queued()).toHaveLength(pushes);
  });

  it('stores an input change that renders the same pass without a version or a push', async () => {
    const pass = await kit.makePass({ gate: 'D1' });
    const pushes = () =>
      all<{ id: string }>(
        kit.env.DB,
        `SELECT id FROM pass_events WHERE pass_id = ? AND kind IN ('push.queued', 'pass.updated')`,
        [pass.id],
      );
    const before = await pushes();
    const versions = (await getPass(kit.env.DB, pass.id, null))?.version;
    // {} -> {message: ''} renders as before: the field is removed when empty.
    const cleared = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor,
      notify: false,
      mutate: (p) => ({ personalization: { ...p.personalization, message: '' } }),
    });
    // An input the template never renders.
    const note = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor,
      notify: true,
      mutate: (p) => ({ personalization: { ...p.personalization, note: 'hello' } }),
    });
    expect([cleared.changed, note.changed]).toEqual([false, false]);
    expect(await pushes()).toHaveLength(before.length);
    const row = await getPass(kit.env.DB, pass.id, null);
    expect(row?.personalization).toMatchObject({ message: '', note: 'hello' });
    const versionRows = await all<{ version: number }>(
      kit.env.DB,
      'SELECT version FROM pass_versions WHERE pass_id = ?',
      [pass.id],
    );
    expect(versionRows).toHaveLength(1);
    expect(row?.version).toBeGreaterThanOrEqual(versions ?? 0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { checkRule } from './check.ts';
import { claimFire, releaseFire } from './repo-window.ts';
import { ORIGIN, type RuleKit, ruleKit } from './test-kit.ts';
import { tickMessageRules } from './tick.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 10:00 UTC on the day after the kit's clock: memberships must predate a rule's saves.
let T0 = 0;
let kit: RuleKit;

beforeEach(async () => {
  kit = await ruleKit();
  T0 = (Math.floor(kit.clock.now() / DAY) + 1) * DAY + 10 * HOUR;
  kit.clock.set(T0);
});

const created = async (body: Record<string, unknown>) => {
  const res = await kit.send('POST', '/message-rules', kit.ruleBody(body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const check = (ruleId: string, at = kit.clock.now()) => checkRule(jobCtxOf(kit), { ruleId, at });
const runs = (ruleId: string) =>
  all<{ id: string; state: string; target: string }>(
    kit.env.DB,
    'SELECT id, state, target FROM broadcasts WHERE rule_id = ? AND parent_id IS NULL ORDER BY id',
    [ruleId],
  );
const messageOf = async (passId: string) =>
  (await getPass(kit.env.DB, passId, kit.org.id))?.personalization.message;
const ruleRow = (id: string) =>
  first<{
    state: string;
    paused_code: string | null;
    sent: number;
    skipped: number;
    next_check_at: number | null;
  }>(
    kit.env.DB,
    'SELECT state, paused_code, sent, skipped, next_check_at FROM message_rules WHERE id = ?',
    [id],
  );
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('day rule on a date input', () => {
  it('fires once per expiry, again for a renewed one, never for an unchanged one', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const other = await kit.datedPass({ expiry: date(T0 + 20 * DAY) });
    const id = await created({});
    await check(id);
    expect((await runs(id)).length).toBe(1);
    await kit.runDue();
    expect(await messageOf(pass.id)).toBe('Renew soon.');
    expect(await messageOf(other.id)).toBeUndefined();
    expect((await ruleRow(id))?.sent).toBe(1);

    // Same window again: the fire row excludes the pass, no empty broadcast.
    kit.clock.set(T0 + 3 * HOUR);
    await check(id);
    expect((await runs(id)).length).toBe(1);

    // Unchanged expiry on a later day: its window has passed.
    kit.clock.set(T0 + DAY);
    await check(id);
    expect((await runs(id)).length).toBe(1);

    // Renewed expiry: a new occurrence fires. The text differs, so the pass really changes.
    await run(kit.env.DB, "UPDATE message_rules SET message = 'Renew again.' WHERE id = ?", [id]);
    await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
      JSON.stringify({ memberName: 'Alex', expiry: date(T0 + 8 * DAY), message: 'Renew soon.' }),
      pass.id,
    ]);
    await check(id);
    expect((await runs(id)).length).toBe(2);
    await kit.runDue();
    expect((await ruleRow(id))?.sent).toBe(2);
    expect(await messageOf(pass.id)).toBe('Renew again.');
  });

  it('is idempotent for a retried job and never catches up a missed day', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created({});
    await check(id, T0);
    await check(id, T0);
    expect((await runs(id)).length).toBe(1);
    // After 21:00 the day is closed; a pass created for a past window never fires.
    const late = await created({ name: 'Late', sendAt: '10:00' });
    await check(late, Date.UTC(2026, 2, 2, 22, 0));
    expect((await runs(late)).length).toBe(0);
  });

  it('the clearing follow-up touches only the passes the run updated', async () => {
    const hit = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created({ clearAfter: 2 * HOUR });
    await check(id);
    await kit.runDue();
    expect(await messageOf(hit.id)).toBe('Renew soon.');
    const later = await kit.datedPass({ expiry: date(T0 + 40 * DAY) });
    await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
      JSON.stringify({ memberName: 'Alex', expiry: date(T0 + 40 * DAY), message: 'Renew soon.' }),
      later.id,
    ]);
    kit.clock.set(T0 + 3 * HOUR);
    await kit.runDue();
    expect(await messageOf(hit.id)).toBe('');
    expect(await messageOf(later.id)).toBe('Renew soon.');
  });
});

describe('hour and last-scan rules', () => {
  it('hour rule fires once inside its window and not after a long outage', async () => {
    const soon = await kit.datedPass({ startsAt: new Date(T0 + HOUR).toISOString() });
    const missed = await kit.datedPass({ startsAt: new Date(T0 + 20 * 60_000).toISOString() });
    const id = await created({
      anchor: { kind: 'input', input: 'startsAt' },
      offset: { amount: 1, unit: 'hour', when: 'before' },
    });
    await check(id);
    await kit.runDue();
    expect(await messageOf(soon.id)).toBe('Renew soon.');
    // 40 min late: the due time was 20 min before the grace window opened.
    expect(await messageOf(missed.id)).toBeUndefined();
    await check(id, T0 + 10 * 60_000);
    expect((await runs(id)).length).toBe(1);
  });

  it('last scan: fires 21 days after the last done scan, moved by a later scan', async () => {
    const quiet = await kit.datedPass();
    const back = await kit.datedPass();
    const scan = (passId: string, n: string, at: number) =>
      run(
        kit.env.DB,
        `INSERT INTO scans (id, org_id, mode, pass_id, actor_type, actor_id, actor_key, idempotency_key, request_hash, method, state, outcome, action_kind, at)
         VALUES (?, ?, 'live', ?, 'system', 'system', 'system', ?, 'h', 'manual', 'done', 'ok', 'check_in', ?)`,
        [`s-${n}`, kit.org.id, passId, n, at],
      );
    await scan(quiet.id, 'a', T0 - 21 * DAY - HOUR);
    await scan(back.id, 'b', T0 - 21 * DAY - HOUR);
    await scan(back.id, 'c', T0 - 10 * DAY);
    const id = await created({
      anchor: { kind: 'lastScan' },
      offset: { amount: 21, unit: 'day', when: 'after' },
    });
    await check(id);
    await kit.runDue();
    expect(await messageOf(quiet.id)).toBe('Renew soon.');
    expect(await messageOf(back.id)).toBeUndefined();
  });
});

describe('budget and fire claims', () => {
  it('defers a pass at the rule limit without a claim, and sends it later', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    for (let i = 0; i < 2; i++)
      await run(
        kit.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at) VALUES (?, ?, ?, 'live', 'pass.updated', '{"notified":true}', ?)`,
        [`ev${i}`, kit.org.id, pass.id, T0 - HOUR],
      );
    const id = await created({});
    await check(id);
    await kit.runDue();
    expect(await messageOf(pass.id)).toBeUndefined();
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM message_rule_fires WHERE rule_id = ?', [id]),
    ).toEqual([]);
    expect((await ruleRow(id))?.skipped).toBe(1);
    // The day's events age out of the 24 h window: the next check inside the day sends it.
    kit.clock.set(T0 + 3 * HOUR);
    await run(kit.env.DB, 'DELETE FROM pass_events');
    await check(id);
    await kit.runDue();
    expect(await messageOf(pass.id)).toBe('Renew soon.');
  });

  it('claims once, releases on request, and a standing claim skips the pass', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created({});
    const window = {
      kind: 'date',
      input: 'expiry',
      date: date(T0 + 7 * DAY),
      occurrence: 'anchor',
    } as const;
    const claim = {
      ruleId: id,
      broadcastId: 'b1',
      passId: pass.id,
      orgId: kit.org.id,
      mode: 'live',
      window,
      now: T0,
      slots: 2,
    };
    expect(await claimFire(kit.env.DB, claim)).toBe('claimed');
    expect(await claimFire(kit.env.DB, { ...claim, broadcastId: 'b2' })).toBe('duplicate');
    expect(await claimFire(kit.env.DB, claim)).toBe('claimed');
    await check(id);
    expect((await runs(id)).length).toBe(0);
    await releaseFire(kit.env.DB, id, pass.id, 'b1');
    expect(await claimFire(kit.env.DB, claim)).toBe('claimed');
  });
});

describe('lifecycle and back-pressure', () => {
  it('pauses with RULE_CREATOR_REVOKED when the saver loses access, and sends nothing', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created({});
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE user_id = ?', [
      T0,
      'admin-1',
    ]);
    await check(id);
    expect(await ruleRow(id)).toMatchObject({
      state: 'paused',
      paused_code: 'RULE_CREATOR_REVOKED',
    });
    expect((await runs(id)).length).toBe(0);
  });

  it('pauses with RULE_INPUT_MISSING when a template loses the input', async () => {
    const id = await created({});
    await run(kit.env.DB, "UPDATE message_rules SET anchor_input = 'gone' WHERE id = ?", [id]);
    await check(id);
    expect(await ruleRow(id)).toMatchObject({ state: 'paused', paused_code: 'RULE_INPUT_MISSING' });
  });

  it('keeps its place, not pausing, while a template has no release and no active passes', async () => {
    const id = await created({});
    const bare = await kit.releasedIn([]);
    await run(
      kit.env.DB,
      "UPDATE message_rules SET template_ids = ?, anchor_input = 'expires' WHERE id = ?",
      [JSON.stringify([bare.id]), id],
    );
    await check(id);
    const row = await ruleRow(id);
    expect(row).toMatchObject({ state: 'on', paused_code: null });
    expect(row?.next_check_at).toBeGreaterThan(kit.clock.now());
  });

  it('pauses, not reschedules, when its template was deleted', async () => {
    const id = await created({});
    await run(kit.env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [kit.dated.id]);
    await check(id);
    expect(await ruleRow(id)).toMatchObject({ state: 'paused', paused_code: 'RULE_INPUT_MISSING' });
  });

  it('defers while its own run is still waiting', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created({});
    await check(id);
    kit.clock.set(T0 + 3 * HOUR);
    await run(kit.env.DB, "UPDATE broadcasts SET state = 'sending' WHERE rule_id = ?", [id]);
    await check(id);
    expect((await runs(id)).length).toBe(1);
    expect((await ruleRow(id))?.next_check_at).toBe(T0 + 3 * HOUR + 10 * 60_000);
  });
});

describe('tick', () => {
  it('claims at most 50 due rules, leases them, and re-claims after 5 minutes', async () => {
    const send = vi.spyOn(kit.env.JOBS, 'sendBatch').mockResolvedValue({} as never);
    for (let i = 0; i < 53; i++) await created({ name: `R${i}`, on: i < 10 });
    await run(kit.env.DB, 'DELETE FROM message_rules');
    for (let i = 0; i < 53; i++)
      await run(
        kit.env.DB,
        `INSERT INTO message_rules (id, org_id, mode, name, state, template_ids, anchor_kind, anchor_input, offset_amount, offset_unit, offset_when, time_zone, message, next_check_at, created_at, edited_at)
         VALUES (?, ?, 'live', 'R', 'on', '[]', 'input', 'expiry', 1, 'day', 'before', 'UTC', 'm', ?, 1, 1)`,
        [`r${String(i).padStart(2, '0')}`, kit.org.id, T0 - 1000 + i],
      );
    const ctx = jobCtxOf(kit);
    await tickMessageRules(ctx);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toHaveLength(50);
    await tickMessageRules(ctx);
    expect(send.mock.calls[1]?.[0]).toHaveLength(3);
    await tickMessageRules(ctx);
    expect(send).toHaveBeenCalledTimes(2);
    kit.clock.set(T0 + 6 * 60_000);
    await tickMessageRules(ctx);
    expect(send.mock.calls[2]?.[0]).toHaveLength(50);
    expect(ORIGIN).toBeTruthy();
  });
});

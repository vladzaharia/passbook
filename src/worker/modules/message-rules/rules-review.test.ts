import { beforeEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { checkRule } from './check.ts';
import { dailyMessageRules } from './jobs.ts';
import { setNextCheck } from './repo.ts';
import { claimFire } from './repo-window.ts';
import { type RuleKit, ruleKit } from './test-kit.ts';
import { tickMessageRules } from './tick.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let T0 = 0;
let kit: RuleKit;

beforeEach(async () => {
  kit = await ruleKit();
  await run(kit.env.DB, 'DELETE FROM message_rule_fires');
  await run(kit.env.DB, 'DELETE FROM message_rules');
  await run(kit.env.DB, 'DELETE FROM broadcasts');
  T0 = (Math.floor(kit.clock.now() / DAY) + 1) * DAY + 10 * HOUR;
  kit.clock.set(T0);
});

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const created = async (body: Record<string, unknown> = {}) =>
  ((await (await kit.send('POST', '/message-rules', kit.ruleBody(body))).json()) as { id: string })
    .id;
const check = (ruleId: string, at = kit.clock.now()) => checkRule(jobCtxOf(kit), { ruleId, at });

describe('H1: run caps hold under concurrency', () => {
  it('5 rules due in one org create 3 runs', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await created({ name: `R${i}` }));
    await Promise.all(ids.map((id) => check(id)));
    const runs = await all(
      kit.env.DB,
      `SELECT id FROM broadcasts WHERE rule_id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(ids)],
    );
    expect(runs).toHaveLength(3);
  });

  it('counts waiting runs, so a second check of the same rule makes no stacked run', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created();
    await check(id, T0);
    await check(id, T0 + 1000);
    expect(await all(kit.env.DB, 'SELECT 1 FROM broadcasts WHERE rule_id = ?', [id])).toHaveLength(
      1,
    );
  });
});

describe('M1: test sends are limited', () => {
  it('one per rule a minute, ten per person an hour', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 30 * DAY) });
    const id = await created();
    const send = () => kit.send('POST', `/message-rules/${id}/test`, { passId: pass.id });
    expect((await send()).status).toBe(201);
    const again = await send();
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toBe('60');
    let sent = 1;
    for (; sent < 10; sent++) {
      kit.clock.set(T0 + sent * 2 * 60_000);
      expect((await send()).status).toBe(201);
    }
    kit.clock.set(T0 + sent * 2 * 60_000);
    expect((await send()).status).toBe(429);
  });
});

describe('M2: overlapping ticks lease each rule once', () => {
  it('enqueues each due rule in exactly one tick', async () => {
    const sent: string[] = [];
    vi.spyOn(kit.env.JOBS, 'sendBatch').mockImplementation(async (messages) => {
      for (const m of messages) sent.push((m.body as { ruleId: string }).ruleId);
      return {} as never;
    });
    for (let i = 0; i < 6; i++)
      await run(
        kit.env.DB,
        `INSERT INTO message_rules (id, org_id, mode, name, state, template_ids, anchor_kind, anchor_input, offset_amount, offset_unit, offset_when, time_zone, message, next_check_at, created_at, edited_at)
         VALUES (?, ?, 'live', 'R', 'on', '[]', 'input', 'expiry', 1, 'day', 'before', 'UTC', 'm', ?, 1, 1)`,
        [`t${i}`, kit.org.id, T0 - 1000],
      );
    const ctx = jobCtxOf(kit);
    await Promise.all([tickMessageRules(ctx), tickMessageRules(ctx), tickMessageRules(ctx)]);
    expect(sent.sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
  });
});

describe('M3: rule sends per pass are capped in the claim', () => {
  it('the third rule to claim one pass in a day is refused', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const [a, b, c] = [
      await created({ name: 'A' }),
      await created({ name: 'B' }),
      await created({ name: 'C' }),
    ];
    const window = {
      kind: 'date',
      input: 'expiry',
      date: date(T0 + 7 * DAY),
      occurrence: 'anchor',
    } as const;
    const claim = (ruleId: string) =>
      claimFire(kit.env.DB, {
        ruleId,
        broadcastId: `b-${ruleId}`,
        passId: pass.id,
        orgId: kit.org.id,
        mode: 'live',
        window,
        now: T0,
        slots: 2,
      });
    expect(await Promise.all([claim(a as string), claim(b as string)])).toEqual([
      'claimed',
      'claimed',
    ]);
    expect(await claim(c as string)).toBe('full');
    // A day later the slots are free again.
    expect(
      await claimFire(kit.env.DB, {
        ruleId: c as string,
        broadcastId: 'later',
        passId: pass.id,
        orgId: kit.org.id,
        mode: 'live',
        window,
        now: T0 + DAY + 1,
        slots: 2,
      }),
    ).toBe('claimed');
  });
});

describe('L1: sessions read rules of their own mode only', () => {
  it('a live session cannot read a test rule', async () => {
    const res = await kit.api('/message-rules', {
      method: 'POST',
      headers: { ...kit.auth.admin({ mode: 'test' }), 'content-type': 'application/json' },
      body: JSON.stringify(kit.ruleBody({ on: false })),
    });
    const id = ((await res.json()) as { id: string }).id;
    expect((await kit.api(`/message-rules/${id}`, { headers: kit.auth.admin() })).status).toBe(404);
    expect((await kit.api(`/message-rules/${id}/runs`, { headers: kit.auth.admin() })).status).toBe(
      404,
    );
    expect(
      (await kit.api(`/message-rules/${id}`, { headers: kit.auth.admin({ mode: 'test' }) })).status,
    ).toBe(200);
  });
});

describe('L2: the fire purge drains in batches', () => {
  it('deletes a backlog larger than one batch in one run', async () => {
    const pass = await kit.datedPass();
    const id = await created();
    await run(
      kit.env.DB,
      `INSERT INTO message_rule_fires (rule_id, pass_id, occurrence, org_id, mode, fired_at)
       SELECT ?, ?, 'o' || value, ?, 'live', 1 FROM json_each(?)`,
      [id, pass.id, kit.org.id, JSON.stringify(Array.from({ length: 25 }, (_, i) => i))],
    );
    await dailyMessageRules(jobCtxOf(kit), 10);
    expect(await all(kit.env.DB, 'SELECT 1 FROM message_rule_fires')).toEqual([]);
  });
});

describe('L3: stale jobs and edits', () => {
  it('drops a job older than the lease', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created();
    await check(id, T0 - 6 * 60_000);
    expect(await all(kit.env.DB, 'SELECT 1 FROM broadcasts WHERE rule_id = ?', [id])).toEqual([]);
  });

  it('a check never overwrites the schedule of a rule edited meanwhile', async () => {
    const id = await created();
    const before = await first<{ version: number }>(
      kit.env.DB,
      'SELECT version FROM message_rules WHERE id = ?',
      [id],
    );
    await run(
      kit.env.DB,
      'UPDATE message_rules SET version = version + 1, next_check_at = 123 WHERE id = ?',
      [id],
    );
    await setNextCheck(kit.env.DB, id, before?.version ?? 0, 999_999);
    expect(
      await first(kit.env.DB, 'SELECT next_check_at FROM message_rules WHERE id = ?', [id]),
    ).toEqual({ next_check_at: 123 });
  });
});

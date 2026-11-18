import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures, makeOrg } from '../../../../test/helpers/index.ts';
import { countQueries } from '../../jobs/query-counter.ts';
import { all, first, run } from '../../platform/db.ts';
import { createLogger } from '../../platform/log.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { applyChunk } from '../broadcasts/apply.ts';
import { casState } from '../broadcasts/repo.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { checkRule } from './check.ts';
import { type RuleKit, ruleKit } from './test-kit.ts';
import { tickMessageRules } from './tick.ts';

vi.mock('../passes/publish.ts', async (original) => {
  const actual = await original<typeof import('../passes/publish.ts')>();
  return { ...actual, publishPass: vi.fn(actual.publishPass) };
});

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
const runs = (ruleId: string) =>
  all<{ id: string }>(kit.env.DB, 'SELECT id FROM broadcasts WHERE rule_id = ? ORDER BY id', [
    ruleId,
  ]);
const messageOf = async (passId: string) =>
  (await getPass(kit.env.DB, passId, kit.org.id))?.personalization.message;
const sendingRows = (n: number, orgId: string, mode: string, prefix: string) =>
  run(
    kit.env.DB,
    `INSERT INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, rule_id, window_key, created_at)
     SELECT ? || value, ?, ?, 'message', 'B', 'sending', '{"templateIds":["t"]}', '{"message":"Hi"}', ? || value, 'k', 1
     FROM json_each(?)`,
    [prefix, orgId, mode, prefix, JSON.stringify(Array.from({ length: n }, (_, i) => i))],
  );

describe('preview', () => {
  it('counts the passes due each of the next 14 days', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    await kit.datedPass({ expiry: date(T0 + 10 * DAY) });
    await kit.datedPass({ expiry: date(T0 + 10 * DAY) });
    await kit.datedPass({ expiry: date(T0 + 40 * DAY) });
    const res = await kit.send('POST', '/message-rules/preview', kit.ruleBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: { date: string; count: number }[];
      total: number;
      atLimit: number;
    };
    expect(body.days).toHaveLength(14);
    expect(body.days[0]).toEqual({ date: date(T0), count: 1 });
    expect(body.days[3]?.count).toBe(2);
    expect(body.total).toBe(3);
    expect(body.atLimit).toBe(0);
  });

  it('leaves out passes a saved rule already sent, and reports those at the limit', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    for (let i = 0; i < 2; i++)
      await run(
        kit.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at) VALUES (?, ?, ?, 'live', 'pass.updated', '{"notified":true}', ?)`,
        [`pv${i}`, kit.org.id, pass.id, T0 - HOUR],
      );
    const id = await created();
    const first = (await (
      await kit.send('POST', '/message-rules/preview', { ...kit.ruleBody(), ruleId: id })
    ).json()) as { atLimit: number; total: number };
    expect(first).toMatchObject({ total: 1, atLimit: 1 });
    await run(
      kit.env.DB,
      `INSERT INTO message_rule_fires (rule_id, pass_id, occurrence, org_id, mode, fired_at) VALUES (?, ?, ?, ?, 'live', 1)`,
      [id, pass.id, date(T0 + 7 * DAY), kit.org.id],
    );
    const after = (await (
      await kit.send('POST', '/message-rules/preview', { ...kit.ruleBody(), ruleId: id })
    ).json()) as { total: number };
    expect(after.total).toBe(0);
  });

  it('uses real hours for hour rules', async () => {
    await kit.datedPass({ startsAt: new Date(T0 + 5 * HOUR).toISOString() });
    const res = await kit.send(
      'POST',
      '/message-rules/preview',
      kit.ruleBody({
        anchor: { kind: 'input', input: 'startsAt' },
        offset: { amount: 1, unit: 'hour', when: 'before' },
      }),
    );
    const body = (await res.json()) as { days: { count: number }[] };
    expect(body.days[0]?.count).toBe(1);
    expect(body.days.slice(1).every((d) => d.count === 0)).toBe(true);
  });
});

describe('test send', () => {
  it('sends the text now to one pass, notifies, and writes no fire row', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 30 * DAY) });
    const other = await kit.datedPass({ expiry: date(T0 + 31 * DAY) });
    const id = await created();
    const res = await kit.send('POST', `/message-rules/${id}/test`, { passId: pass.id });
    expect(res.status).toBe(201);
    await kit.runDue();
    expect(await messageOf(pass.id)).toBe('Renew soon.');
    expect(await messageOf(other.id)).toBeUndefined();
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM message_rule_fires WHERE rule_id = ?', [id]),
    ).toEqual([]);
    const events = await all<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'message.applied'",
      [pass.id],
    );
    expect(events.map((e) => JSON.parse(e.data).notified)).toEqual([true]);
  });

  it('refuses a pass of another template, and a live pass for a test-mode rule', async () => {
    const wrong = await kit.makePass();
    const id = await created();
    expect((await kit.send('POST', `/message-rules/${id}/test`, { passId: wrong.id })).status).toBe(
      404,
    );
    const live = await kit.datedPass({ expiry: date(T0 + 30 * DAY) });
    const testRule = await kit.api('/message-rules', {
      method: 'POST',
      headers: { ...kit.auth.admin({ mode: 'test' }), 'content-type': 'application/json' },
      body: JSON.stringify(kit.ruleBody({ on: false })),
    });
    const testId = ((await testRule.json()) as { id: string }).id;
    const res = await kit.api(`/message-rules/${testId}/test`, {
      method: 'POST',
      headers: { ...kit.auth.admin({ mode: 'test' }), 'content-type': 'application/json' },
      body: JSON.stringify({ passId: live.id }),
    });
    expect(res.status).toBe(404);
    expect(await messageOf(live.id)).toBeUndefined();
  });
});

describe('back-pressure caps', () => {
  it('defers at 3 sending rule runs in the org and mode, not at 2', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created();
    await sendingRows(2, kit.org.id, 'live', 'org');
    await check(id);
    expect((await runs(id)).length).toBe(1);
    await run(kit.env.DB, "DELETE FROM broadcasts WHERE id LIKE 'org%' OR rule_id = ?", [id]);
    await run(kit.env.DB, 'DELETE FROM message_rule_fires');
    await sendingRows(3, kit.org.id, 'live', 'org');
    await check(id);
    expect((await runs(id)).length).toBe(0);
  });

  it('defers at 15 sending rule runs platform-wide, not at 14', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created();
    const other = await makeOrg(fixtures(kit.env), {});
    await sendingRows(14, other.id, 'live', 'pf');
    await check(id);
    expect((await runs(id)).length).toBe(1);
    await run(kit.env.DB, 'DELETE FROM broadcasts WHERE rule_id = ?', [id]);
    await run(kit.env.DB, 'DELETE FROM message_rule_fires');
    await sendingRows(1, other.id, 'live', 'pg');
    await check(id);
    expect((await runs(id)).length).toBe(0);
  });
});

describe('another org', () => {
  it('cannot read, change, test or run a rule of an org the admin is not in', async () => {
    const other = await makeOrg(fixtures(kit.env), {});
    const id = 'foreign-rule';
    await run(
      kit.env.DB,
      `INSERT INTO message_rules (id, org_id, mode, name, state, template_ids, anchor_kind, anchor_input, offset_amount, offset_unit, offset_when, time_zone, message, next_check_at, created_at, edited_at)
       VALUES (?, ?, 'live', 'F', 'on', ?, 'input', 'expiry', 1, 'day', 'before', 'UTC', 'm', ?, 1, 1)`,
      [id, other.id, JSON.stringify([kit.dated.id]), T0],
    );
    const pass = await kit.datedPass({ expiry: date(T0 + 1 * DAY) });
    expect((await kit.api(`/message-rules/${id}`, { headers: kit.auth.admin() })).status).toBe(404);
    expect(
      (await kit.send('PUT', `/message-rules/${id}`, { ...kit.ruleBody(), version: 1 })).status,
    ).toBe(404);
    expect((await kit.send('POST', `/message-rules/${id}/pause`)).status).toBe(404);
    expect((await kit.send('POST', `/message-rules/${id}/test`, { passId: pass.id })).status).toBe(
      404,
    );
    expect((await kit.send('DELETE', `/message-rules/${id}`)).status).toBe(404);
    const list = (await (
      await kit.api(`/message-rules?orgId=${other.id}`, { headers: kit.auth.admin() })
    ).json()) as { items?: unknown[] };
    expect(list.items ?? []).toEqual([]);
    // The runner: the other org has no such passes, so nothing is sent.
    await check(id);
    expect((await runs(id)).length).toBe(0);
    expect(await messageOf(pass.id)).toBeUndefined();
  });
});

describe('logs', () => {
  it('carry no message text, emails or dates', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((line: unknown) => void lines.push(String(line))),
    );
    try {
      const secret = date(T0 + 7 * DAY);
      await kit.datedPass({ expiry: secret }, 'holder.private@example.test');
      const id = await created({ message: 'Private clinic text.' });
      const ctx = {
        ...jobCtxOf(kit),
        log: createLogger({}, { sink: (line) => void lines.push(line) }),
      };
      await checkRule(ctx, { ruleId: id, at: kit.clock.now() });
      await kit.runDue();
      await run(kit.env.DB, 'UPDATE message_rules SET anchor_input = ? WHERE id = ?', ['gone', id]);
      await checkRule(ctx, { ruleId: id, at: kit.clock.now() });
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).toContain('message_rule.run_created');
    expect(text).not.toContain('Private clinic text.');
    expect(text).not.toContain('holder.private');
    expect(text).not.toContain(date(T0 + 7 * DAY));
  });
});

describe('tick cost', () => {
  it('runs the same number of queries for 1 or 50 due rules', async () => {
    vi.spyOn(kit.env.JOBS, 'sendBatch').mockResolvedValue({} as never);
    const insert = (n: number, tag: string) =>
      run(
        kit.env.DB,
        `INSERT INTO message_rules (id, org_id, mode, name, state, template_ids, anchor_kind, anchor_input, offset_amount, offset_unit, offset_when, time_zone, message, next_check_at, created_at, edited_at)
         SELECT ? || value, ?, 'live', 'R', 'on', '[]', 'input', 'expiry', 1, 'day', 'before', 'UTC', 'm', ?, 1, 1 FROM json_each(?)`,
        [tag, kit.org.id, T0 - 1000, JSON.stringify(Array.from({ length: n }, (_, i) => i))],
      );
    const cost = async () => {
      const counter = countQueries(kit.env);
      const base = jobCtxOf(kit);
      await tickMessageRules(
        createJobContext(counter.env, 'test', { clock: base.clock, log: base.log }),
      );
      return counter.count();
    };
    await run(kit.env.DB, 'DELETE FROM message_rules');
    await insert(1, 'a');
    const one = await cost();
    await run(kit.env.DB, 'DELETE FROM message_rules');
    await insert(60, 'b');
    const many = await cost();
    expect(many).toBe(one);
    expect(one).toBeLessThanOrEqual(3);
  });
});

describe('crashes around the publish', () => {
  const startRun = async (id: string) => {
    await check(id);
    const [{ id: broadcastId } = { id: '' }] = await runs(id);
    await casState(kit.env.DB, broadcastId, ['scheduled'], 'sending', {
      startedAt: kit.clock.now(),
    });
    return broadcastId;
  };

  it('a crash after the claim loses nothing for this run and never doubles another', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created();
    const broadcastId = await startRun(id);
    vi.mocked(publishPass).mockRejectedValueOnce(new Error('boom'));
    await expect(applyChunk(jobCtxOf(kit), broadcastId, null)).rejects.toThrow('boom');
    expect(
      (await all(kit.env.DB, 'SELECT 1 FROM message_rule_fires WHERE rule_id = ?', [id])).length,
    ).toBe(1);
    expect(await messageOf(pass.id)).toBeUndefined();
    // A later check (another run) skips the pass: its claim stands.
    kit.clock.set(T0 + 3 * HOUR);
    await run(kit.env.DB, "UPDATE broadcasts SET state = 'failed' WHERE id = ?", [broadcastId]);
    await check(id);
    expect((await runs(id)).length).toBe(1);
    // The same run retried resumes its own claim and publishes once.
    await run(kit.env.DB, "UPDATE broadcasts SET state = 'sending' WHERE id = ?", [broadcastId]);
    await applyChunk(jobCtxOf(kit), broadcastId, null);
    expect(await messageOf(pass.id)).toBe('Renew soon.');
    const events = await all(
      kit.env.DB,
      "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'message.applied'",
      [pass.id],
    );
    expect(events).toHaveLength(1);
  });

  it('a crash after the publish still counts the pass on retry', async () => {
    const pass = await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created();
    const broadcastId = await startRun(id);
    vi.mocked(publishPass).mockImplementationOnce(async (ctx, input) => {
      const { publishPass: real } =
        await vi.importActual<typeof import('../passes/publish.ts')>('../passes/publish.ts');
      await real(ctx, input);
      throw new Error('crash after publish');
    });
    await expect(applyChunk(jobCtxOf(kit), broadcastId, null)).rejects.toThrow(
      'crash after publish',
    );
    expect(await messageOf(pass.id)).toBe('Renew soon.');
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM broadcast_items WHERE broadcast_id = ?', [broadcastId]),
    ).toEqual([]);
    await applyChunk(jobCtxOf(kit), broadcastId, null);
    const items = await all<{ outcome: string }>(
      kit.env.DB,
      'SELECT outcome FROM broadcast_items WHERE broadcast_id = ?',
      [broadcastId],
    );
    expect(items).toEqual([{ outcome: 'updated' }]);
    expect(await first(kit.env.DB, 'SELECT sent FROM message_rules WHERE id = ?', [id])).toEqual({
      sent: 1,
    });
  });
});

describe('a stored zone that left the database', () => {
  it('pauses the rule with RULE_TARGET_INVALID instead of throwing', async () => {
    await kit.datedPass({ expiry: date(T0 + 7 * DAY) });
    const id = await created();
    await run(kit.env.DB, 'UPDATE message_rules SET match = ? WHERE id = ?', [
      JSON.stringify([{ input: 'expiry', from: '2026-01-01', timeZone: 'Mars/Base' }]),
      id,
    ]);
    await check(id);
    expect(
      await first(kit.env.DB, 'SELECT state, paused_code FROM message_rules WHERE id = ?', [id]),
    ).toEqual({ state: 'paused', paused_code: 'RULE_TARGET_INVALID' });
    expect((await runs(id)).length).toBe(0);
  });
});

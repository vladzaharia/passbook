import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { type RuleKit, ruleKit } from './test-kit.ts';

let kit: RuleKit;
beforeAll(async () => {
  kit = await ruleKit();
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('message rule routes', () => {
  it('creates, reads, lists, updates, pauses and deletes', async () => {
    const res = await kit.send('POST', '/message-rules', kit.ruleBody());
    expect(res.status).toBe(201);
    const rule = await json(res);
    expect(rule).toMatchObject({
      state: 'on',
      version: 1,
      sent: 0,
      sendAt: '10:00',
      clearAfter: 604_800_000,
    });
    const id = rule.id as string;

    const got = await kit.api(`/message-rules/${id}`, { headers: kit.auth.admin() });
    expect(got.status).toBe(200);
    const list = await json(
      await kit.api(`/message-rules?orgId=${kit.org.id}`, { headers: kit.auth.admin() }),
    );
    expect((list.items as { id: string }[]).map((r) => r.id)).toContain(id);

    const put = await kit.send('PUT', `/message-rules/${id}`, {
      ...kit.ruleBody({ name: 'Renewal 2' }),
      version: 1,
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toMatchObject({ name: 'Renewal 2', version: 2 });

    const paused = await json(await kit.send('POST', `/message-rules/${id}/pause`));
    expect(paused).toMatchObject({ state: 'paused', nextCheckAt: null });

    expect((await kit.send('DELETE', `/message-rules/${id}`)).status).toBe(200);
    expect((await kit.api(`/message-rules/${id}`, { headers: kit.auth.admin() })).status).toBe(404);
  });

  it('refuses a stale version with RULE_VERSION', async () => {
    const rule = await json(await kit.send('POST', '/message-rules', kit.ruleBody({ on: false })));
    const put = await kit.send('PUT', `/message-rules/${rule.id}`, {
      ...kit.ruleBody(),
      version: 7,
    });
    expect(put.status).toBe(409);
    expect(await json(put)).toMatchObject({ code: 'RULE_VERSION' });
  });

  it('checks templates: message field, anchor input, hours need date and time', async () => {
    const noMessage = await kit.send(
      'POST',
      '/message-rules',
      kit.ruleBody({ templateIds: [kit.plain.id] }),
    );
    expect(noMessage.status).toBe(422);
    expect(await json(noMessage)).toMatchObject({ code: 'MESSAGING_UNSUPPORTED' });
    const noInput = await kit.send(
      'POST',
      '/message-rules',
      kit.ruleBody({ anchor: { kind: 'input', input: 'nope' } }),
    );
    expect(await json(noInput)).toMatchObject({ code: 'RULE_INPUT_MISSING' });
    const hours = await kit.send(
      'POST',
      '/message-rules',
      kit.ruleBody({ offset: { amount: 1, unit: 'hour', when: 'before' } }),
    );
    expect(await json(hours)).toMatchObject({ code: 'RULE_HOURS_NEED_DATETIME' });
    const ok = await kit.send(
      'POST',
      '/message-rules',
      kit.ruleBody({
        anchor: { kind: 'input', input: 'startsAt' },
        offset: { amount: 1, unit: 'hour', when: 'before' },
        on: false,
      }),
    );
    expect(ok.status).toBe(201);
  });

  it('hides another org template', async () => {
    const res = await kit.send(
      'POST',
      '/message-rules',
      kit.ruleBody({ templateIds: ['no-such-template'] }),
    );
    expect(res.status).toBe(404);
  });

  it('needs the manage capability: a plain user cannot create', async () => {
    const res = await kit.api('/message-rules', {
      method: 'POST',
      headers: { ...kit.auth.user(), 'content-type': 'application/json' },
      body: JSON.stringify(kit.ruleBody()),
    });
    expect([401, 403, 404]).toContain(res.status);
    expect(
      (await kit.api(`/message-rules?orgId=${kit.org.id}`, { headers: kit.auth.user() })).status,
    ).not.toBe(200);
  });

  it('caps active rules at 10 per org and mode, and lets paused ones be added', async () => {
    await run(kit.env.DB, 'DELETE FROM message_rules');
    for (let i = 0; i < 10; i++)
      expect(
        (await kit.send('POST', '/message-rules', kit.ruleBody({ name: `R${i}` }))).status,
      ).toBe(201);
    const eleventh = await kit.send('POST', '/message-rules', kit.ruleBody());
    expect(eleventh.status).toBe(409);
    expect(await json(eleventh)).toMatchObject({ code: 'RULE_LIMIT' });
    expect((await kit.send('POST', '/message-rules', kit.ruleBody({ on: false }))).status).toBe(
      201,
    );
  });

  it('refuses a fire row whose pass is in another org or mode', async () => {
    await run(kit.env.DB, 'DELETE FROM message_rules');
    const rule = await json(await kit.send('POST', '/message-rules', kit.ruleBody()));
    const pass = await kit.datedPass();
    const insert = (orgId: string, mode: string) =>
      run(
        kit.env.DB,
        `INSERT INTO message_rule_fires (rule_id, pass_id, occurrence, org_id, mode, fired_at) VALUES (?, ?, 'x', ?, ?, 1)`,
        [rule.id as string, pass.id, orgId, mode],
      );
    await expect(insert('other-org', 'live')).rejects.toThrow(/rule_fire_tenant/);
    await expect(insert(kit.org.id, 'test')).rejects.toThrow(/rule_fire_tenant/);
    await insert(kit.org.id, 'live');
    expect((await all(kit.env.DB, 'SELECT 1 FROM message_rule_fires')).length).toBe(1);
  });

  it('delete cancels scheduled runs', async () => {
    await run(kit.env.DB, 'DELETE FROM message_rules');
    const rule = await json(await kit.send('POST', '/message-rules', kit.ruleBody()));
    await run(
      kit.env.DB,
      `INSERT INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, rule_id, window_key, created_at)
       VALUES ('b-sched', ?, 'live', 'message', 'B', 'scheduled', '{"templateIds":["t"]}', '{"message":"Hi"}', ?, 'k', 1),
              ('b-send', ?, 'live', 'message', 'B', 'sending', '{"templateIds":["t"]}', '{"message":"Hi"}', ?, 'k2', 1)`,
      [kit.org.id, rule.id as string, kit.org.id, rule.id as string],
    );
    await kit.send('DELETE', `/message-rules/${rule.id}`);
    const rows = await all<{ id: string; state: string }>(
      kit.env.DB,
      "SELECT id, state FROM broadcasts WHERE id IN ('b-sched','b-send') ORDER BY id",
    );
    expect(rows).toEqual([
      { id: 'b-sched', state: 'cancelled' },
      { id: 'b-send', state: 'sending' },
    ]);
  });

  it('keeps rule runs out of the manual broadcast list', async () => {
    const manual = await json(
      await kit.api(`/broadcasts?orgId=${kit.org.id}`, { headers: kit.auth.admin() }),
    );
    expect((manual.items as { id: string }[]).map((b) => b.id)).not.toContain('b-send');
    const rules = await json(
      await kit.api(`/broadcasts?orgId=${kit.org.id}&origin=rule`, { headers: kit.auth.admin() }),
    );
    expect((rules.items as { id: string }[]).map((b) => b.id)).toContain('b-send');
  });
});

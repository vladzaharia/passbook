import { describe, expect, it } from 'vitest';
import { makeScanEvent } from '../../../../test/helpers/index.ts';
import { runJob } from '../../jobs/registry.ts';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { applyChannelPage } from './apply-page.ts';
import { gateOne, startOne } from './apply-run.ts';
import { type ApplyKit, applyKit } from './apply-test-fixtures.ts';
import { insertCopy } from './repo.ts';

const MINUTE = 60_000;

async function replaceKit(
  copies: ('apple' | 'google' | 'mobile')[][] = [['apple'], ['apple'], []],
  holders = false,
) {
  const t = await applyKit(copies.length, { scan: true, holders });
  for (const [i, channels] of copies.entries())
    for (const c of channels)
      await insertCopy(
        t.db,
        { id: t.ids[i] as string, orgId: t.orgId, mode: 'live' },
        c,
        t.kit.clock.now(),
      );
  return t;
}

const codes = async (t: ApplyKit) =>
  Object.fromEntries(
    (
      await all<{ id: string; scan_code: string }>(
        t.db,
        `SELECT id, scan_code FROM passes WHERE id IN (${t.ids.map(() => '?').join(',')})`,
        t.ids,
      )
    ).map((r) => [r.id, r.scan_code]),
  );

const replaceSave = async (t: ApplyKit, channels: Record<string, string>) => {
  const res = await t.kit.send('PUT', `/templates/${t.templateId}/channels`, {
    orgId: t.orgId,
    revision: await t.revision(),
    channels,
    replaceCodes: true,
  });
  if (res.status !== 200) throw new Error(`save ${res.status} ${await res.text()}`);
  return ((await res.json()) as { workflowInstanceId: string }).workflowInstanceId;
};

const mails = (t: ApplyKit, reason: string) =>
  (t.kit.queue.sent as { kind: string; reason?: string; passId: string }[]).filter(
    (m) => m.kind === 'pass.holder_mail' && m.reason === reason,
  );

describe('replace codes: run', () => {
  it('replaces the code of copy holders only, once per run, and leaves the rest alone', async () => {
    const t = await replaceKit();
    const before = await codes(t);
    const id = await replaceSave(t, { apple: 'off' });
    expect(await t.work(id).done).toEqual({ state: 'done' });
    const after = await codes(t);
    expect(after[t.ids[0] as string]).not.toBe(before[t.ids[0] as string]);
    expect(after[t.ids[1] as string]).not.toBe(before[t.ids[1] as string]);
    expect(after[t.ids[2] as string]).toBe(before[t.ids[2] as string]);
    expect(await t.runOf(id)).toMatchObject({
      state: 'done',
      counts: '{"changed":3,"flips":3,"stale":0,"rotated":2,"unsupported":0}',
    });
    const rows = await all<{ actor_id: string }>(
      t.db,
      'SELECT actor_id FROM scan_code_rotations WHERE org_id = ?',
      [t.orgId],
    );
    expect(rows.map((r) => r.actor_id)).toEqual([`channel_apply:${id}`, `channel_apply:${id}`]);
    expect(await t.audits('pass.new_code')).toBe(2);
  });

  it('replays a crash after any step without a second code', async () => {
    for (const retryAt of [3, 4, 5, 6]) {
      const t = await replaceKit([['apple'], ['apple']]);
      const id = await replaceSave(t, { apple: 'off' });
      expect(await t.work(id, { retryAt }).done).toEqual({ state: 'done' });
      expect(await t.runOf(id)).toMatchObject({ counts: expect.stringContaining('"rotated":2') });
      expect(
        (await all(t.db, 'SELECT 1 FROM scan_code_rotations WHERE org_id = ?', [t.orgId])).length,
      ).toBe(2);
    }
  });

  it('keeps an active print active, and its code still admits', async () => {
    const t = await replaceKit([['apple']]);
    const id = t.ids[0] as string;
    await t.exec(
      `INSERT INTO pass_prints (id, pass_id, org_id, mode, print_code_hash, roster_hash, generation, created_by, created_at)
       SELECT 'print-1', id, org_id, mode, ?, ?, 1, 'admin-1', 1 FROM passes WHERE id = ?`,
      'a'.repeat(64),
      'b'.repeat(32),
      id,
    );
    expect(await t.work(await replaceSave(t, { apple: 'off' })).done).toEqual({ state: 'done' });
    expect(
      await all(t.db, 'SELECT status, void_cause FROM pass_prints WHERE pass_id = ?', [id]),
    ).toEqual([{ status: 'active', void_cause: null }]);
  });

  it('tells a holder with an email once, and records the notice on the mark', async () => {
    const t = await replaceKit([['apple'], ['apple']], true);
    const id = await replaceSave(t, { apple: 'off' });
    expect(await t.work(id, { retryAt: 5 }).done).toEqual({ state: 'done' });
    expect(
      mails(t, 'codes_replaced')
        .map((m) => m.passId)
        .sort(),
    ).toEqual([...t.ids].sort());
    expect(
      await t.count(
        'SELECT COUNT(*) AS n FROM channel_apply_marks WHERE run_id = ? AND notice_at IS NOT NULL',
        id,
      ),
    ).toBe(2);
  });

  it('pauses the pages while an event is open, touches the run, and goes on after it closes', async () => {
    const t = await replaceKit([['apple'], ['apple']]);
    const id = await replaceSave(t, { apple: 'off' });
    const now = t.kit.clock.now();
    await makeScanEvent(t.kit.fx, {
      orgId: t.orgId,
      templateIds: [t.templateId],
      opensAt: now + 5 * MINUTE,
      closesAt: now + 22 * MINUTE,
    });
    const { s, done } = t.work(id);
    expect(await done).toEqual({ state: 'done' });
    const waits = s.names.filter((n) => n.startsWith('window-'));
    expect(waits.length).toBeGreaterThanOrEqual(3);
    // Every round fits inside the stall limit, so a run behind this one does not fail it.
    expect(t.kit.clock.now()).toBeGreaterThanOrEqual(now + 22 * MINUTE);
    expect(await t.runOf(id)).toMatchObject({ counts: expect.stringContaining('"rotated":2') });
  });

  it('gate: no window means no wait; an open window touches updated_at and wakes within five minutes', async () => {
    const t = await replaceKit([['apple']]);
    const id = await replaceSave(t, { apple: 'off' });
    t.kit.clock.advance(11 * MINUTE);
    const ctx = jobCtxOf(t.kit);
    expect(await startOne(ctx, id)).toBe('started');
    expect(await gateOne(ctx, id)).toEqual({ until: null });
    await makeScanEvent(t.kit.fx, { orgId: t.orgId, templateIds: [t.templateId] });
    t.kit.clock.advance(MINUTE);
    const gate = await gateOne(ctx, id);
    expect(gate.until).toBe(t.kit.clock.now() + 5 * MINUTE);
    expect((await t.runOf(id))?.updated_at).toBe(t.kit.clock.now());
  });

  it('a run without replace never waits for a window', async () => {
    const t = await replaceKit([['apple']]);
    await makeScanEvent(t.kit.fx, { orgId: t.orgId, templateIds: [t.templateId] });
    const { s, done } = t.work((await t.saved({ apple: 'off' })).workflowInstanceId as string);
    expect(await done).toEqual({ state: 'done' });
    expect(s.names.some((n) => n.startsWith('window-'))).toBe(false);
  });

  it('skips the replacement when the requester lost templates:publish, and says so', async () => {
    const t = await replaceKit([['apple']]);
    const id = await replaceSave(t, { apple: 'off' });
    const before = await codes(t);
    await t.exec(
      "UPDATE org_memberships SET revoked_at = 1 WHERE org_id = ? AND user_id = 'admin-1'",
      t.orgId,
    );
    await t.exec("UPDATE users SET last_roles = '[]' WHERE id = 'admin-1'");
    expect(await t.work(id).done).toEqual({ state: 'done' });
    expect(await codes(t)).toEqual(before);
    expect(await t.runOf(id)).toMatchObject({ error_code: 'REPLACE_PRINCIPAL_REVOKED' });
  });

  it('counts a pass whose barcode is not the scan code as unsupported', async () => {
    // A template that lost its scan-code barcode after the save: the run cannot rotate its passes.
    const t = await applyKit(1);
    await t.exec('UPDATE passes SET scan_code = scan_code');
    await insertCopy(
      t.db,
      { id: t.ids[0] as string, orgId: t.orgId, mode: 'live' },
      'apple',
      t.kit.clock.now(),
    );
    const id = (await t.saved({ apple: 'off' })).workflowInstanceId as string;
    await t.exec('UPDATE channel_apply_runs SET replace_channels = \'["apple"]\' WHERE id = ?', id);
    const before = await t.db
      .prepare('SELECT scan_code FROM passes WHERE id = ?')
      .bind(t.ids[0])
      .first();
    expect(await t.work(id).done).toEqual({ state: 'done' });
    expect(
      await t.db.prepare('SELECT scan_code FROM passes WHERE id = ?').bind(t.ids[0]).first(),
    ).toEqual(before);
    expect(await t.runOf(id)).toMatchObject({ counts: expect.stringContaining('"unsupported":1') });
  });
});

describe('replace codes: bulk job', () => {
  it('waits for the window by sending itself again, then replaces once', async () => {
    const t = await replaceKit([['apple']]);
    const passId = t.ids[0] as string;
    const res = await t.kit.send('POST', '/passes/bulk/channels', {
      orgId: t.orgId,
      ids: [passId],
      action: 'off',
      channels: ['apple'],
      replaceCodes: true,
    });
    expect(res.status).toBe(200);
    const job = (t.kit.queue.sent as { kind: string; key?: string }[]).find(
      (m) => m.kind === 'channel.replace_code',
    );
    expect(job).toMatchObject({ passId, key: expect.stringMatching(/^channel_bulk:/) });
    const before = await codes(t);
    const event = await makeScanEvent(t.kit.fx, {
      orgId: t.orgId,
      templateIds: [t.templateId],
      closesAt: t.kit.clock.now() + 30 * MINUTE,
    });
    const resent: { delaySeconds?: number }[] = [];
    const send = t.kit.env.JOBS.send.bind(t.kit.env.JOBS);
    t.kit.env.JOBS.send = (async (m: unknown, o?: { delaySeconds?: number }) => {
      resent.push(o ?? {});
      return send(m as never, o as never);
    }) as typeof t.kit.env.JOBS.send;
    await runJob(job as never, jobCtxOf(t.kit));
    expect(await codes(t)).toEqual(before);
    expect(resent.at(-1)?.delaySeconds).toBe(30 * 60);
    await t.exec('UPDATE scan_events SET archived_at = 1 WHERE id = ?', event.id);
    await runJob(job as never, jobCtxOf(t.kit));
    expect((await codes(t))[passId]).not.toBe(before[passId]);
    // A repeat of the same job finds the mark and does nothing.
    const again = await codes(t);
    await runJob(job as never, jobCtxOf(t.kit));
    expect(await codes(t)).toEqual(again);
  });
});

describe('replace codes: notice survives a crash, no second code, limiter', () => {
  const bulkJob = async (t: ApplyKit, passId: string) => {
    const res = await t.kit.send('POST', '/passes/bulk/channels', {
      orgId: t.orgId,
      ids: [passId],
      action: 'off',
      channels: ['apple'],
      replaceCodes: true,
    });
    expect(res.status).toBe(200);
    return (t.kit.queue.sent as { kind: string }[])
      .filter((m) => m.kind === 'channel.replace_code')
      .at(-1) as never;
  };
  const outbox = (t: ApplyKit, passId: string) =>
    all(t.db, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [passId]);

  it('tells the holder exactly once even when the first notice was lost', async () => {
    const t = await replaceKit([['apple']], true);
    const passId = t.ids[0] as string;
    const job = await bulkJob(t, passId);
    const ctx = jobCtxOf(t.kit);
    await runJob(job, ctx);
    const lost = mails(t, 'codes_replaced');
    expect(lost).toHaveLength(1);
    // The crash: the notice was never delivered. The retry finds the rotation done and queues it again.
    await runJob(job, ctx);
    const queued = mails(t, 'codes_replaced');
    expect(queued).toHaveLength(2);
    await runJob(queued[1] as never, ctx);
    await runJob(queued[0] as never, ctx);
    expect(await outbox(t, passId)).toHaveLength(1);
  });

  it('does not rotate again for a channel retired before the last new code, in bulk or on the pass', async () => {
    const t = await replaceKit([['apple']]);
    const passId = t.ids[0] as string;
    const job = await bulkJob(t, passId);
    await runJob(job, jobCtxOf(t.kit));
    const once = await codes(t);
    const other = { ...(job as object), key: 'channel_bulk:other' } as never;
    await runJob(other, jobCtxOf(t.kit));
    expect(await codes(t)).toEqual(once);
    t.kit.clock.advance(1000);
    const res = await t.kit.send('PUT', `/passes/${passId}/channels`, {
      channels: { apple: 'off' },
      replaceCodes: true,
    });
    expect(res.status).toBe(200);
    expect(await codes(t)).toEqual(once);
    expect(
      await t.count('SELECT COUNT(*) AS n FROM scan_code_rotations WHERE pass_id = ?', passId),
    ).toBe(1);
  });

  it('counts a bulk rotation against the New code limit, and waits when it is spent', async () => {
    const t = await replaceKit([['apple']]);
    const passId = t.ids[0] as string;
    const job = await bulkJob(t, passId);
    const now = t.kit.clock.now();
    const win = now - (now % 3_600_000);
    const key = `passes:newcode:${passId}`;
    const { read, bump } = await import('../../platform/counters.ts');
    await bump(t.db, key, win, 3);
    await expect(runJob(job, jobCtxOf(t.kit))).rejects.toMatchObject({ status: 429 });
    t.kit.clock.advance(3_600_000);
    await runJob(job, jobCtxOf(t.kit));
    const next = t.kit.clock.now() - (t.kit.clock.now() % 3_600_000);
    expect(await read(t.db, key, next)).toBe(1);
  });
});

describe('replace codes: tenants, modes and page size', () => {
  it("another org's and the other mode's events and sessions never block", async () => {
    const t = await replaceKit([['apple']]);
    const other = await t.otherOrg();
    await makeScanEvent(t.kit.fx, { orgId: other.orgId, templateIds: [t.templateId] });
    await makeScanEvent(t.kit.fx, { orgId: t.orgId, mode: 'test', templateIds: [t.templateId] });
    const hold = JSON.stringify({ state: 'open', until: t.kit.clock.now() + 3_600_000 });
    for (const [org, mode] of [
      [other.orgId, 'live'],
      [t.orgId, 'test'],
    ] as [string, string][])
      await t.exec(
        `INSERT INTO scanning_sessions (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at, hours, hold)
         VALUES (?, ?, ?, 'S', NULL, '{}', 'UTC', 1, 1, NULL, ?)`,
        `s-${org}-${mode}`,
        org,
        mode,
        hold,
      );
    const res = await t.kit.send('PUT', `/templates/${t.templateId}/channels`, {
      orgId: t.orgId,
      revision: 0,
      channels: { apple: 'off' },
      replaceCodes: true,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { windows: unknown[] }).windows).toEqual([]);
  });

  it('rotatedCount and rotatedSince do not cross tenants', async () => {
    const t = await replaceKit([['apple']]);
    const other = await t.otherOrg();
    const { rotatedCount } = await import('./repo-replace.ts');
    const { rotatedSince } = await import('./repo.ts');
    expect(await rotatedCount(t.db, t.orgId, 'live', t.templateId, 'apple', 'off')).toBe(1);
    expect(await rotatedCount(t.db, other.orgId, 'live', t.templateId, 'apple', 'off')).toBe(0);
    expect(await rotatedCount(t.db, t.orgId, 'test', t.templateId, 'apple', 'off')).toBe(0);
    await t.work(await replaceSave(t, { apple: 'off' })).done;
    expect(await rotatedSince(t.db, t.orgId, t.ids[0] as string, 0)).toBe(true);
    expect(await rotatedSince(t.db, other.orgId, t.ids[0] as string, 0)).toBe(false);
  });

  it('a run that replaces codes takes five passes a page; one without takes a full page', async () => {
    const t = await replaceKit(Array.from({ length: 7 }, () => ['apple' as const]));
    const id = await replaceSave(t, { apple: 'off' });
    t.kit.clock.advance(11 * MINUTE);
    const ctx = jobCtxOf(t.kit);
    expect(await startOne(ctx, id)).toBe('started');
    const page = await applyChannelPage(ctx, id);
    expect(page.done).toBe(false);
    expect(await t.runOf(id)).toMatchObject({ counts: expect.stringContaining('"rotated":5') });
    expect((await applyChannelPage(ctx, id)).done).toBe(true);
    expect(await t.runOf(id)).toMatchObject({ counts: expect.stringContaining('"rotated":7') });
    const plain = await replaceKit(Array.from({ length: 7 }, () => ['apple' as const]));
    const w = plain.work((await plain.saved({ apple: 'off' })).workflowInstanceId as string);
    await w.done;
    expect(w.s.names.filter((n) => n.startsWith('page-'))).toHaveLength(1);
  });
});

describe('a run longer than one instance', () => {
  const sevenPasses = () => replaceKit(Array.from({ length: 7 }, () => ['apple' as const]));
  const strictCreate = (t: ApplyKit) => {
    const seen = new Set<string>();
    const create = t.kit.env.CHANNEL_APPLY.create.bind(t.kit.env.CHANNEL_APPLY);
    t.kit.env.CHANNEL_APPLY.create = (async (o: { id: string; params: unknown }) => {
      if (seen.has(o.id)) throw new Error('instance.already_exists');
      seen.add(o.id);
      return create(o as never);
    }) as never;
  };

  it('hands off at the page cap and finishes in the next instance, with no double events or codes', async () => {
    const t = await sevenPasses();
    const id = await replaceSave(t, { apple: 'off' });
    const first = t.work(id, { maxPages: 1 });
    expect(await first.done).toEqual({ state: 'running' });
    expect((await t.runOf(id))?.state).toBe('running');
    const next = t.created.find((c) => c.id === `${id}-c1`);
    expect(next?.params).toEqual({ runId: id, cont: 1 });
    expect(await t.work(id, { maxPages: 1, cont: 1 }).done).toEqual({ state: 'done' });
    expect(await t.runOf(id)).toMatchObject({
      state: 'done',
      counts: expect.stringContaining('"rotated":7'),
    });
    expect(await t.feed()).toBe(7);
    expect(
      await t.count('SELECT COUNT(*) AS n FROM scan_code_rotations WHERE org_id = ?', t.orgId),
    ).toBe(7);
  });

  it('a crash during the hand-off resumes once', async () => {
    // The index of the hand-off step, from an identical run.
    const probe = await sevenPasses();
    const run = probe.work(await replaceSave(probe, { apple: 'off' }), { maxPages: 1 });
    await run.done;
    const handoffAt = run.s.names.indexOf('handoff');
    expect(handoffAt).toBeGreaterThan(0);
    const t = await sevenPasses();
    strictCreate(t);
    const id = await replaceSave(t, { apple: 'off' });
    expect(await t.work(id, { maxPages: 1, retryAt: handoffAt }).done).toEqual({
      state: 'running',
    });
    expect(t.created.filter((c) => c.id === `${id}-c1`)).toHaveLength(1);
    expect(await t.work(id, { maxPages: 1, cont: 1 }).done).toEqual({ state: 'done' });
    expect(await t.feed()).toBe(7);
  });

  it('shows life at the hand-off so the status check does not read it as stalled', async () => {
    const t = await sevenPasses();
    const id = await replaceSave(t, { apple: 'off' });
    await t.work(id, { maxPages: 1 }).done;
    expect(Number((await t.runOf(id))?.updated_at)).toBe(t.kit.clock.now());
  });
});

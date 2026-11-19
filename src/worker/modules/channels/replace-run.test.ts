import { describe, expect, it } from 'vitest';
import { makeScanEvent } from '../../../../test/helpers/index.ts';
import { runJob } from '../../jobs/registry.ts';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
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

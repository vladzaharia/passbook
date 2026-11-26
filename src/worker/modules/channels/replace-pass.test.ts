import { describe, expect, it } from 'vitest';
import { makeScanEvent } from '../../../../test/helpers/index.ts';
import { runJob } from '../../jobs/registry.ts';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { toDto } from '../operations/dto.ts';
import { kindOf, kinds } from '../operations/kinds.ts';
import { rowById } from '../operations/repo.ts';
import { sweepStalledOperations } from '../operations/stalls.ts';
import { type ApplyKit, applyKit } from './apply-test-fixtures.ts';
import { insertCopy } from './repo.ts';

async function passKit(opts: { scan?: boolean; holders?: boolean } = { scan: true }) {
  const t = await applyKit(1, opts);
  await insertCopy(
    t.db,
    { id: t.ids[0] as string, orgId: t.orgId, mode: 'live' },
    'apple',
    t.kit.clock.now(),
  );
  return t;
}

const putPass = (t: ApplyKit, body: Record<string, unknown>) =>
  t.kit.send('PUT', `/passes/${t.ids[0]}/channels`, body);

const scanCode = async (t: ApplyKit) =>
  (
    await t.db
      .prepare('SELECT scan_code FROM passes WHERE id = ?')
      .bind(t.ids[0])
      .first<{ scan_code: string }>()
  )?.scan_code;

const jobs = (t: ApplyKit, kind: string) =>
  (t.kit.queue.sent as { kind: string; reason?: string }[]).filter((m) => m.kind === kind);

describe('replace codes: one pass', () => {
  it('turns the channel off, issues a new code now, notes it on the audit and tells the holder', async () => {
    const t = await passKit({ scan: true, holders: true });
    const before = await scanCode(t);
    const res = await putPass(t, { channels: { apple: 'off' }, replaceCodes: true });
    expect(res.status).toBe(200);
    expect(await scanCode(t)).not.toBe(before);
    expect(jobs(t, 'pass.holder_mail').map((j) => j.reason)).toEqual(['codes_replaced']);
    const audit = await all<{ detail: string }>(
      t.db,
      "SELECT detail FROM audit_log WHERE action = 'pass.channels_change' AND target_id = ?",
      [t.ids[0] as string],
    );
    expect(JSON.parse(audit[0]?.detail as string)).toMatchObject({ codesReplaced: true });
  });

  it('a plain turn off never rotates, and mails only when notify is on and a copy existed', async () => {
    const t = await passKit({ scan: true, holders: true });
    const before = await scanCode(t);
    expect((await putPass(t, { channels: { apple: 'off' } })).status).toBe(200);
    expect(await scanCode(t)).toBe(before);
    expect(jobs(t, 'pass.holder_mail')).toEqual([
      expect.objectContaining({ reason: 'channel_off', channels: ['apple'] }),
    ]);
    const quiet = await passKit({ scan: true, holders: true });
    await putPass(quiet, { channels: { apple: 'off' }, notify: false });
    expect(jobs(quiet, 'pass.holder_mail')).toEqual([]);
  });

  it('refuses before writing: all digital off, an unsupported barcode, an open window', async () => {
    const t = await passKit();
    const all4 = { mobile: 'off', apple: 'off', google: 'off', samsung: 'off' };
    const full = await putPass(t, { channels: all4, replaceCodes: true });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'CHANNEL_REPLACE_ALL_OFF' });

    await makeScanEvent(t.kit.fx, { orgId: t.orgId, templateIds: [t.templateId] });
    const held = await putPass(t, { channels: { apple: 'off' }, replaceCodes: true });
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ code: 'CHANNEL_REPLACE_WINDOW_OPEN' });

    const plain = await passKit({ scan: false });
    const unsupported = await putPass(plain, { channels: { apple: 'off' }, replaceCodes: true });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toMatchObject({ code: 'NEW_CODE_UNSUPPORTED' });
    // Nothing was written by any refusal.
    for (const k of [t, plain])
      expect(
        await k.count(
          'SELECT COUNT(*) AS n FROM pass_channels WHERE pass_id = ? AND override IS NOT NULL',
          k.ids[0] as string,
        ),
      ).toBe(0);
  });

  it('shares the New code limit: the fourth in an hour is refused before the change', async () => {
    const t = await passKit();
    for (let i = 0; i < 3; i++) {
      t.kit.clock.advance(1000);
      expect((await putPass(t, { channels: { apple: 'off' }, replaceCodes: true })).status).toBe(
        200,
      );
      expect((await putPass(t, { channels: { apple: null } })).status).toBe(200);
    }
    t.kit.clock.advance(1000);
    const res = await putPass(t, { channels: { apple: 'off' }, replaceCodes: true });
    expect(res.status).toBe(429);
    expect(
      await t.count(
        "SELECT COUNT(*) AS n FROM pass_channels WHERE pass_id = ? AND override = 'off'",
        t.ids[0] as string,
      ),
    ).toBe(0);
  });

  it('exposes whether codes can be replaced, and the windows, on the pass', async () => {
    const t = await passKit();
    const get = async () =>
      (await (
        await t.kit.api(`/passes/${t.ids[0]}/channels`, { headers: t.kit.auth.admin() })
      ).json()) as {
        replace: {
          supported: boolean;
          owed: boolean;
          blocked: { name: string } | null;
          lastDigital: string[];
          windows: unknown[];
        };
      };
    expect((await get()).replace).toEqual({
      supported: true,
      owed: true,
      blocked: null,
      lastDigital: [],
      windows: [],
    });
    await makeScanEvent(t.kit.fx, { orgId: t.orgId, templateIds: [t.templateId] });
    const held = (await get()).replace;
    expect(held.blocked).toMatchObject({ name: 'Event' });
    expect(held.windows).toEqual([]);
    // With mobile off, Apple is the last digital channel: turning it off leaves no code to send.
    await putPass(t, { channels: { mobile: 'off' } });
    expect((await get()).replace.lastDigital).toEqual(['apple']);
    const plain = await passKit({ scan: false });
    const res = await plain.kit.api(`/passes/${plain.ids[0]}/channels`, {
      headers: plain.kit.auth.admin(),
    });
    expect(((await res.json()) as { replace: { supported: boolean } }).replace.supported).toBe(
      false,
    );
  });
});

describe('replace codes: bulk', () => {
  it('queues one job per pass turned off, none for on or reset', async () => {
    const t = await passKit();
    const bulk = (action: string) =>
      t.kit.send('POST', '/passes/bulk/channels', {
        orgId: t.orgId,
        ids: [t.ids[0]],
        action,
        channels: ['apple'],
        replaceCodes: true,
      });
    expect((await bulk('on')).status).toBe(200);
    expect(jobs(t, 'channel.replace_code')).toHaveLength(0);
    expect((await bulk('off')).status).toBe(200);
    expect(jobs(t, 'channel.replace_code')).toHaveLength(1);
  });

  it('dry run previews per-channel counts and windows, and writes nothing', async () => {
    const t = await passKit();
    const before = await scanCode(t);
    const now = t.kit.clock.now();
    await makeScanEvent(t.kit.fx, {
      orgId: t.orgId,
      templateIds: [t.templateId],
      opensAt: now - 60_000,
      closesAt: now + 3_600_000,
    });
    const res = await t.kit.send('POST', '/passes/bulk/channels', {
      orgId: t.orgId,
      ids: [t.ids[0]],
      action: 'off',
      channels: ['apple'],
      replaceCodes: true,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      done: number;
      preview: {
        impact: unknown[];
        unsupported: number;
        allOff: number;
        blocked: { name: string } | null;
        windows: unknown[];
      };
    };
    expect(body.done).toBe(0);
    expect(body.preview.impact).toEqual([{ channel: 'apple', passes: 1, rotated: 1 }]);
    expect(body.preview).toMatchObject({ unsupported: 0, allOff: 0 });
    expect(body.preview.blocked).toMatchObject({ name: 'Event' });
    expect(body.preview.windows).toEqual([]);
    expect(await scanCode(t)).toBe(before);
    expect(jobs(t, 'channel.replace_code')).toHaveLength(0);
    // Without the box the same dry run owes no code.
    const plain = await t.kit.send('POST', '/passes/bulk/channels', {
      orgId: t.orgId,
      ids: [t.ids[0]],
      action: 'off',
      channels: ['apple'],
      dryRun: true,
    });
    expect(((await plain.json()) as { preview: { impact: unknown[] } }).preview.impact).toEqual([
      { channel: 'apple', passes: 1, rotated: 0 },
    ]);
  });

  it('dry run counts passes whose barcode is not the scan code as unsupported', async () => {
    const t = await passKit({ scan: false });
    const res = await t.kit.send('POST', '/passes/bulk/channels', {
      orgId: t.orgId,
      ids: [t.ids[0]],
      action: 'off',
      channels: ['apple'],
      replaceCodes: true,
      dryRun: true,
    });
    const { preview } = (await res.json()) as {
      preview: { impact: { rotated: number }[]; unsupported: number };
    };
    expect(preview.unsupported).toBe(1);
    expect(preview.impact[0]?.rotated).toBe(0);
  });

  it('dry run counts every pass of a template once per channel', async () => {
    const t = await applyKit(3, { scan: true });
    for (const id of t.ids)
      await insertCopy(t.db, { id, orgId: t.orgId, mode: 'live' }, 'apple', t.kit.clock.now());
    const res = await t.kit.send('POST', '/passes/bulk/channels', {
      orgId: t.orgId,
      ids: t.ids,
      action: 'off',
      channels: ['apple'],
      replaceCodes: true,
      dryRun: true,
    });
    const { preview } = (await res.json()) as { preview: { impact: unknown[] } };
    expect(preview.impact).toEqual([{ channel: 'apple', passes: 3, rotated: 3 }]);
  });
});

describe('replace codes: operation', () => {
  const bulk = (t: ApplyKit, body: Record<string, unknown> = {}) =>
    t.kit.send('POST', '/passes/bulk/channels', {
      orgId: t.orgId,
      ids: [t.ids[0]],
      action: 'off',
      channels: ['apple'],
      replaceCodes: true,
      ...body,
    });
  const opOf = async (t: ApplyKit, id: string) => toDto((await rowById(t.kit.env.DB, id)) as never);

  it('answers operationId only when a code is to be replaced, and counts each pass to Done', async () => {
    const t = await passKit();
    const plain = (await (await bulk(t, { replaceCodes: false })).json()) as {
      operationId: string | null;
    };
    expect(plain.operationId).toBeNull();
    const body = (await (await bulk(t)).json()) as { done: number; operationId: string };
    expect(body.operationId).toBeTruthy();
    const queued = await opOf(t, body.operationId);
    expect(queued).toMatchObject({
      kind: 'channels.replace_codes',
      status: 'running',
      orgId: t.orgId,
    });
    expect(queued.steps.map((x) => [x.state, x.done, x.total])).toEqual([
      ['done', 1, 1],
      ['running', 0, 1],
    ]);
    const job = jobs(t, 'channel.replace_code')[0];
    expect(job).toMatchObject({ operationId: body.operationId, attempt: 1 });
    await runJob(job as never, jobCtxOf(t.kit));
    expect(await opOf(t, body.operationId)).toMatchObject({
      status: 'succeeded',
      text: 'Codes replaced',
      result: { ids: { replaced: '1' } },
    });
  });

  it('a pass waiting for a scan window shows the operation as waiting, with no count', async () => {
    const t = await passKit();
    const now = t.kit.clock.now();
    await makeScanEvent(t.kit.fx, {
      orgId: t.orgId,
      templateIds: [t.templateId],
      opensAt: now - 60_000,
      closesAt: now + 3_600_000,
    });
    const body = (await (await bulk(t)).json()) as { operationId: string };
    const job = jobs(t, 'channel.replace_code')[0];
    await runJob(job as never, jobCtxOf(t.kit));
    const waiting = await opOf(t, body.operationId);
    expect(waiting).toMatchObject({ status: 'waiting', text: 'Waiting for a scan window' });
    expect(waiting.steps[1]?.done).toBe(0);
  });

  it('ends a row failed when the delayed job is lost: the sweep sees a wait that ran out (M1)', async () => {
    const t = await passKit();
    const now = t.kit.clock.now();
    await makeScanEvent(t.kit.fx, {
      orgId: t.orgId,
      templateIds: [t.templateId],
      opensAt: now - 60_000,
      closesAt: now + 3_600_000,
    });
    const body = (await (await bulk(t)).json()) as { operationId: string };
    await runJob(jobs(t, 'channel.replace_code')[0] as never, jobCtxOf(t.kit));
    expect((await opOf(t, body.operationId)).status).toBe('waiting');
    // A wake-up a little after `until` is not a stall (L2)...
    t.kit.clock.advance(3_600_000 + 60_000);
    await sweepStalledOperations(jobCtxOf(t.kit));
    expect((await opOf(t, body.operationId)).status).toBe('waiting');
    // ...but one that never comes, past the kind's stall time, is.
    t.kit.clock.advance(31 * 60_000);
    await sweepStalledOperations(jobCtxOf(t.kit));
    expect(await opOf(t, body.operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'OPERATION_STALLED' },
    });
  });

  it('still queues the rotations when the operation row cannot be made (M4)', async () => {
    const t = await passKit();
    const def = kindOf('channels.replace_codes');
    kinds.delete('channels.replace_codes');
    try {
      const body = (await (await bulk(t)).json()) as { operationId: string | null };
      expect(body.operationId).toBeNull();
      const job = jobs(t, 'channel.replace_code')[0] as { operationId?: string } | undefined;
      expect(job).toBeDefined();
      expect(job?.operationId).toBeUndefined();
    } finally {
      if (def) kinds.set('channels.replace_codes', def);
    }
  });

  it('counts a redelivered job once (L1)', async () => {
    const t = await passKit();
    const body = (await (await bulk(t, { ids: [t.ids[0]] })).json()) as { operationId: string };
    const queued = jobs(t, 'channel.replace_code')[0];
    const before = (await opOf(t, body.operationId)).steps[1];
    expect(before?.total).toBe(1);
    await runJob(queued as never, jobCtxOf(t.kit));
    await runJob(queued as never, jobCtxOf(t.kit));
    expect((await opOf(t, body.operationId)).steps[1]).toMatchObject({ done: 1, total: 1 });
  });
});

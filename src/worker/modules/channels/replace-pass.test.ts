import { describe, expect, it } from 'vitest';
import { makeScanEvent } from '../../../../test/helpers/index.ts';
import { all } from '../../platform/db.ts';
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
        replace: { supported: boolean; windows: { open: boolean }[] };
      };
    expect((await get()).replace).toEqual({ supported: true, windows: [] });
    await makeScanEvent(t.kit.fx, { orgId: t.orgId, templateIds: [t.templateId] });
    expect((await get()).replace.windows).toEqual([expect.objectContaining({ open: true })]);
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
});

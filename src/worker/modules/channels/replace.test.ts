import { describe, expect, it } from 'vitest';
import { makeScanEvent } from '../../../../test/helpers/index.ts';
import type { ApplyKit } from './apply-test-fixtures.ts';
import { applyKit } from './apply-test-fixtures.ts';
import { insertCopy } from './repo.ts';

const HOUR = 3_600_000;

async function scanKit(
  copies: ('apple' | 'google' | 'samsung' | 'mobile')[][] = [['apple'], ['apple'], []],
) {
  const t = await applyKit(copies.length, { scan: true });
  const now = t.kit.clock.now();
  for (const [i, channels] of copies.entries())
    for (const c of channels)
      await insertCopy(t.db, { id: t.ids[i] as string, orgId: t.orgId, mode: 'live' }, c, now);
  return t;
}

const put = (t: ApplyKit, body: Record<string, unknown>) =>
  t.kit.send('PUT', `/templates/${t.templateId}/channels`, { orgId: t.orgId, ...body });

describe('replace codes: save', () => {
  it('refuses a template whose barcode is not the scan code, and a dry run says so', async () => {
    const t = await applyKit(1);
    const dry = await put(t, {
      revision: 0,
      channels: { apple: 'off' },
      replaceCodes: true,
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ replaceSupported: false });
    const res = await put(t, { revision: 0, channels: { apple: 'off' }, replaceCodes: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NEW_CODE_UNSUPPORTED' });
    expect(await t.runs()).toHaveLength(0);
  });

  it('refuses when no digital channel stays on', async () => {
    const t = await scanKit();
    const res = await put(t, {
      revision: 0,
      channels: { mobile: 'off', apple: 'off', google: 'off', samsung: 'off' },
      replaceCodes: true,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CHANNEL_REPLACE_ALL_OFF' });
  });

  it('counts, per channel, the passes with a copy that the save leaves off', async () => {
    const t = await scanKit([['apple'], ['apple', 'google'], ['google']]);
    const res = await put(t, {
      revision: 0,
      channels: { apple: 'off', google: 'off' },
      replaceCodes: true,
      dryRun: true,
    });
    const body = (await res.json()) as { impact: { channel: string; rotated: number }[] };
    expect(Object.fromEntries(body.impact.map((i) => [i.channel, i.rotated]))).toEqual({
      apple: 2,
      google: 2,
    });
    // Without the box, nothing rotates.
    const plain = (await (
      await put(t, { revision: 0, channels: { apple: 'off' }, dryRun: true })
    ).json()) as {
      impact: { rotated: number }[];
    };
    expect(plain.impact.every((i) => i.rotated === 0)).toBe(true);
  });

  it('stores the channels on the pending run and unions them across saves', async () => {
    const t = await scanKit();
    await t.saved({ apple: 'off' });
    expect((await t.runs())[0]).toMatchObject({ replace_channels: '[]' });
    const res = await put(t, {
      revision: await t.revision(),
      channels: { google: 'off' },
      replaceCodes: true,
    });
    expect(res.status).toBe(200);
    const rows = await t.runs();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.replace_channels as string)).toEqual(['apple', 'google']);
  });
});

describe('replace codes: windows', () => {
  const at = (t: ApplyKit, o: { opensAt?: number; closesAt?: number }) =>
    makeScanEvent(t.kit.fx, { orgId: t.orgId, templateIds: [t.templateId], ...o });

  it('refuses while an event of the template is open, with its name and close time', async () => {
    const t = await scanKit();
    await at(t, {});
    const res = await put(t, { revision: 0, channels: { apple: 'off' }, replaceCodes: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe('CHANNEL_REPLACE_WINDOW_OPEN');
    expect(body.detail).toMatch(
      /Codes can't change while Event is open\. Try after \d{4}-\d\d-\d\d \d\d:\d\d UTC\./,
    );
    // A plain turn off is never held up by a window.
    expect((await put(t, { revision: 0, channels: { apple: 'off' } })).status).toBe(200);
  });

  it('the dry run says what blocks and whether no digital channel stays on, so clients render only', async () => {
    const t = await scanKit();
    const dryOf = async (channels: Record<string, string>) =>
      (await (
        await put(t, { revision: 0, channels, dryRun: true, replaceCodes: true })
      ).json()) as {
        blocked: { name: string; closesAt: number | null } | null;
        allOff: boolean;
        windows: unknown[];
      };
    expect(await dryOf({ apple: 'off' })).toMatchObject({ blocked: null, allOff: false });
    await at(t, {});
    const open = await dryOf({ apple: 'off' });
    expect(open.blocked).toEqual({ name: 'Event', closesAt: expect.any(Number) });
    expect(open.windows).toEqual([]);
    expect(
      (await dryOf({ apple: 'off', mobile: 'off', google: 'off', samsung: 'off' })).allOff,
    ).toBe(true);
  });

  it('warns about a window inside 48 hours but saves; one past 48 hours is not listed', async () => {
    const t = await scanKit();
    const now = t.kit.clock.now();
    await at(t, { opensAt: now + 24 * HOUR, closesAt: now + 30 * HOUR });
    await at(t, { opensAt: now + 60 * HOUR, closesAt: now + 66 * HOUR });
    const dry = (await (
      await put(t, { revision: 0, channels: { apple: 'off' }, dryRun: true })
    ).json()) as { windows: { kind: string; open: boolean }[] };
    expect(dry.windows).toHaveLength(1);
    expect(dry.windows[0]).toMatchObject({ kind: 'event', open: false });
    expect(
      (await put(t, { revision: 0, channels: { apple: 'off' }, replaceCodes: true })).status,
    ).toBe(200);
  });

  it('refuses while a scheduled session is open, and only warns for a session with no hours', async () => {
    const t = await scanKit();
    const now = t.kit.clock.now();
    const session = (name: string, extra: string, accepts: string | null) =>
      t.exec(
        `INSERT INTO scanning_sessions (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at, hours, hold)
         VALUES (?, ?, 'live', ?, ?, '{}', 'UTC', 1, 1, ?, ?)`,
        `s-${name}`,
        t.orgId,
        name,
        accepts as string,
        ...(extra === 'none'
          ? [null as unknown as string, null as unknown as string]
          : [extra, null as unknown as string]),
      );
    await session('Night', 'none', JSON.stringify({ templateIds: [t.templateId] }));
    const warned = await put(t, { revision: 0, channels: { apple: 'off' }, replaceCodes: true });
    expect(warned.status).toBe(200);
    const body = (await warned.json()) as {
      windows: { name: string; scheduled: boolean; open: boolean }[];
    };
    expect(body.windows).toEqual([
      expect.objectContaining({ name: 'Night', scheduled: false, open: false }),
    ]);

    const all = JSON.stringify(
      Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, ['00:00-24:00']]),
      ),
    );
    await t.exec('DELETE FROM scanning_sessions');
    await session('Day', all, null);
    void now;
    const res = await put(t, {
      revision: await t.revision(),
      channels: { google: 'off' },
      replaceCodes: true,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CHANNEL_REPLACE_WINDOW_OPEN' });
  });

  it('ignores a session that does not admit the template, in either accepts shape', async () => {
    const t = await scanKit();
    const hold = JSON.stringify({ state: 'open', until: t.kit.clock.now() + HOUR });
    const insert = (id: string, accepts: string) =>
      t.exec(
        `INSERT INTO scanning_sessions (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at, hours, hold)
         VALUES (?, ?, 'live', ?, ?, '{}', 'UTC', 1, 1, NULL, ?)`,
        id,
        t.orgId,
        id,
        accepts,
        hold,
      );
    await insert('other', JSON.stringify({ templateIds: ['someone-else'] }));
    expect(
      (await put(t, { revision: 0, channels: { apple: 'off' }, replaceCodes: true, dryRun: true }))
        .status,
    ).toBe(200);
    const dry = (await (
      await put(t, { revision: 0, channels: { apple: 'off' }, dryRun: true })
    ).json()) as { windows: unknown[] };
    expect(dry.windows).toEqual([]);
    const ev = await makeScanEvent(t.kit.fx, {
      orgId: t.orgId,
      templateIds: [t.templateId],
      opensAt: t.kit.clock.now() + 100 * HOUR,
      closesAt: t.kit.clock.now() + 101 * HOUR,
    });
    await insert('by-event', JSON.stringify({ eventId: ev.id }));
    await insert('by-events', JSON.stringify({ eventIds: [ev.id] }));
    expect(
      (await put(t, { revision: 0, channels: { apple: 'off' }, replaceCodes: true })).status,
    ).toBe(409);
  });
});

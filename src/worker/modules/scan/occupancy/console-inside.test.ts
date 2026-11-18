import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanWhosInList } from '../../../../shared/contracts/scan-whos-in.ts';
import { all, run } from '../../../platform/db.ts';
import { CHECK_IN } from '../act-test-fixtures.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';
import { personInside, presenceOf, trackedZone, useKit } from './whos-in-test-fixtures.ts';

const fixture = scanningSessionsFixture();
let tpl: string;
beforeAll(async () => {
  await fixture.setup();
  useKit(fixture.kit);
  tpl = await fixture.kit.scanTemplate('Gym', { actions: [CHECK_IN] });
});

describe('console zone: who is inside and Mark as out', () => {
  it('lists the zone and below, once each, and filters by name', async () => {
    const gym = await trackedZone();
    const pool = await trackedZone({ parentId: gym.id });
    await personInside(tpl, 'Ana', [`zone:${gym.id}`, `zone:${pool.id}`]);
    await personInside(tpl, 'Ben', [`zone:${gym.id}`]);
    const res = await fixture.call('GET', `/scan-zones/${gym.id}/inside`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScanWhosInList;
    expect(body.count).toBe(2);
    expect(body.items.map((i) => i.placeName).sort()).toEqual([gym.name, pool.name].sort());
    const filtered = await fixture.call('GET', `/scan-zones/${gym.id}/inside?q=zzz`);
    expect(((await filtered.json()) as ScanWhosInList).items).toEqual([]);
  });

  it('marks someone out once, audited, as the console user', async () => {
    const gym = await trackedZone();
    const place = `zone:${gym.id}`;
    const p = await personInside(tpl, 'Left Behind', [place]);
    const res = await fixture.call('POST', `/scan-zones/${gym.id}/mark-out`, {
      passId: p.id,
      place,
    });
    expect(res.status).toBe(204);
    expect((await presenceOf(p.id, place))[0]?.state).toBe('out');
    const scans = await all<{ actor_type: string; out_cause: string }>(
      fixture.kit.env.DB,
      'SELECT actor_type, out_cause FROM scans WHERE pass_id = ?',
      [p.id],
    );
    expect(scans).toEqual([{ actor_type: 'user', out_cause: 'desk' }]);
    const audit = await all<{ detail: string }>(
      fixture.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'scan.mark_out' AND target_id = ?",
      [p.id],
    );
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ via: 'console', place });
    const again = await fixture.call('POST', `/scan-zones/${gym.id}/mark-out`, {
      passId: p.id,
      place,
    });
    expect(again.status).toBe(409);
  });

  it('refuses a place outside the zone, a plain user and an unknown zone', async () => {
    const gym = await trackedZone();
    const other = await trackedZone();
    const p = await personInside(tpl, 'Other Zone', [`zone:${other.id}`]);
    const outside = await fixture.call('POST', `/scan-zones/${gym.id}/mark-out`, {
      passId: p.id,
      place: `zone:${other.id}`,
    });
    expect(outside.status).toBe(422);
    const user = await fixture.call(
      'POST',
      `/scan-zones/${other.id}/mark-out`,
      { passId: p.id, place: `zone:${other.id}` },
      fixture.userHeaders,
    );
    expect([403, 404]).toContain(user.status);
    expect((await fixture.call('GET', '/scan-zones/nope/inside')).status).toBe(404);
    expect((await presenceOf(p.id, `zone:${other.id}`))[0]?.state).toBe('in');
  });
});

describe('console event', () => {
  it('lists and marks out when the event tracks exits; lists nothing when it does not', async () => {
    const { kit } = fixture;
    const tracks = await kit.event({ templateIds: [tpl] });
    await run(kit.env.DB, 'UPDATE scan_events SET reentry = 1 WHERE id = ?', [tracks.id]);
    const plain = await kit.event({ templateIds: [tpl] });
    const place = `event:${tracks.id}`;
    const p = await personInside(tpl, 'At Event', [place]);
    await personInside(tpl, 'At Plain', [`event:${plain.id}`]);
    const list = (await (
      await fixture.call('GET', `/scan-events/${tracks.id}/inside`)
    ).json()) as ScanWhosInList;
    expect(list.count).toBe(1);
    const none = (await (
      await fixture.call('GET', `/scan-events/${plain.id}/inside`)
    ).json()) as ScanWhosInList;
    expect(none).toMatchObject({ items: [], count: 0 });
    const res = await fixture.call('POST', `/scan-events/${tracks.id}/mark-out`, {
      passId: p.id,
      place,
    });
    expect(res.status).toBe(204);
    expect((await presenceOf(p.id, place))[0]?.state).toBe('out');
  });
});

import { describe, expect, it } from 'vitest';
import { run } from '../../../platform/db.ts';
import { occupancyKit } from './occupancy-test-fixtures.ts';

const MIN = 60_000;

/** Northside Gym, and a second root to move zones under. */
async function gym(label: string) {
  const k = await occupancyKit(label);
  await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120, time_zone: 'UTC' });
  await k.zone('pool', { parent: 'gym', max_stay_minutes: 60 });
  await k.zone('sauna', { parent: 'pool' });
  await k.zone('club', { occupancy: 'track', time_zone: 'UTC' });
  return k;
}

/** A zone save as the console makes it: the fields, and updated_at forward. */
const edit = (
  k: Awaited<ReturnType<typeof gym>>,
  key: string,
  set: string,
  params: unknown[] = [],
) =>
  run(k.db, `UPDATE scan_zones SET ${set}, updated_at = ? WHERE id = ?`, [
    ...(params as (string | number | null)[]),
    k.clock.now(),
    k.idOf(key),
  ]);

describe('undo after a zone change is superseded', () => {
  for (const [name, set, params] of [
    ['Track off', "occupancy = 'off', max_stay_minutes = NULL", []],
    ['archive', 'archived_at = 5', []],
    ['parent move', 'parent_id = ?', ['club']],
  ] as const)
    it(`exit, then ${name}, then undo the exit`, async () => {
      const k = await gym(`undo-${name.replace(' ', '-').toLowerCase()}`);
      const p = await k.pass();
      await k.enter(p, 'gym');
      await k.enter(p, 'pool');
      k.clock.advance(MIN);
      const out = await k.exit(p, 'pool');
      k.clock.advance(MIN);
      await edit(
        k,
        'pool',
        set,
        params.map((v) => (v === 'club' ? k.idOf('club') : v)),
      );
      k.clock.advance(MIN);
      expect(await k.undo(p, [out.scanId])).toBe('UNDO_SUPERSEDED');
      expect((await k.row(p, 'pool'))?.state).toBe('out');
    });

  it('a zone change committed between the undo read and its batch refuses it', async () => {
    const k = await gym('undo-zone-race');
    const p = await k.pass();
    await k.enter(p, 'gym');
    k.clock.advance(MIN);
    const out = await k.exit(p, 'gym');
    k.clock.advance(MIN);
    const undo = await k.planUndo(p, [out.scanId]);
    await edit(k, 'gym', "occupancy = 'track'");
    expect(await undo()).toBe('UNDO_SUPERSEDED');
    expect((await k.row(p, 'gym'))?.state).toBe('out');
  });
});

describe('undo is ordered by commit, not by claim time', () => {
  it('a later write in the same millisecond with a smaller id supersedes', async () => {
    const k = await gym('same-ms');
    const p = await k.pass();
    const a = await k.enter(p, 'gym', { scanId: 'scan-z' });
    await k.enter(p, 'pool', { scanId: 'scan-a' });
    expect(await k.undo(p, [a.scanId])).toBe('UNDO_SUPERSEDED');
    expect((await k.row(p, 'gym'))?.state).toBe('in');
  });

  it('a scan claimed before but committed after supersedes', async () => {
    const k = await gym('claim-order');
    const p = await k.pass();
    const t0 = k.clock.now();
    const late = await k.planEntry(p, 'pool', { waivers: { parent: true }, claimedAt: t0 });
    k.clock.advance(MIN);
    const early = await k.enter(p, 'gym');
    expect((await late()).ok).toBe(true);
    expect(await k.undo(p, [early.scanId])).toBe('UNDO_SUPERSEDED');
  });

  it('a chain undone newest first stops at a row whose history is gone', async () => {
    const k = await gym('chain');
    await k.zone('lounge', { max_stay_minutes: 60 });
    const p = await k.pass();
    await k.enter(p, 'lounge');
    k.clock.advance(MIN);
    const again = await k.enter(p, 'lounge');
    k.clock.advance(MIN);
    const out = await k.exit(p, 'lounge');
    expect(await k.undo(p, [out.scanId])).toBe('ok');
    expect(await k.row(p, 'lounge')).toMatchObject({ state: 'in', last_scan_id: again.scanId });
    // `again` updated a row; with its previous values gone it cannot be put back, and is never deleted.
    expect(await k.undo(p, [again.scanId])).toBe('UNDO_SUPERSEDED');
    expect((await k.row(p, 'lounge'))?.state).toBe('in');
  });

  it('enter, exit, enter: undo the entry, then the exit is refused and its row stays', async () => {
    const k = await gym('chain-exit');
    const p = await k.pass();
    await k.enter(p, 'gym');
    k.clock.advance(MIN);
    const out = await k.exit(p, 'gym');
    k.clock.advance(MIN);
    const back = await k.enter(p, 'gym');
    expect(await k.undo(p, [back.scanId])).toBe('ok');
    expect(await k.row(p, 'gym')).toMatchObject({ state: 'out', last_scan_id: out.scanId });
    expect(await k.undo(p, [out.scanId])).toBe('UNDO_SUPERSEDED');
    expect(await k.row(p, 'gym')).toMatchObject({ state: 'out', last_scan_id: out.scanId });
    // The next forward write takes over the used-up history.
    k.clock.advance(MIN);
    expect((await k.enter(p, 'gym')).ok).toBe(true);
  });

  it('a zone saved up to a minute before the scan counts as saved after it', async () => {
    const k = await gym('zone-skew');
    const p = await k.pass();
    await k.enter(p, 'gym');
    await edit(k, 'gym', "name = 'Gym A'");
    k.clock.advance(30_000);
    const near = await k.exit(p, 'gym');
    k.clock.advance(MIN);
    expect(await k.undo(p, [near.scanId])).toBe('UNDO_SUPERSEDED');
    await k.enter(p, 'gym');
    k.clock.advance(2 * MIN);
    const far = await k.exit(p, 'gym');
    expect(await k.undo(p, [far.scanId])).toBe('ok');
  });

  it('an undone exit puts back someone who never left, even past capacity', async () => {
    const k = await occupancyKit('undo-cap');
    await k.zone('pool', { capacity: 1 });
    const [p, q] = (await k.passes(2)) as [string, string];
    await k.enter(p, 'pool');
    k.clock.advance(MIN);
    const out = await k.exit(p, 'pool');
    expect((await k.enter(q, 'pool')).ok).toBe(true);
    expect(await k.undo(p, [out.scanId])).toBe('ok');
    expect(await k.inside('pool')).toBe(2);
  });
});

describe('entries and exits against the zone tree', () => {
  it('an entry loses to a Track off or a move that commits first', async () => {
    const k = await gym('entry-fence');
    const p = await k.pass();
    await k.enter(p, 'gym');
    const off = await k.planEntry(p, 'pool');
    await edit(k, 'pool', "occupancy = 'off', max_stay_minutes = NULL");
    expect((await off()).ok).toBe(false);
    const moved = await k.planEntry(p, 'sauna', { waivers: { parent: true } });
    await edit(k, 'sauna', 'parent_id = ?', [k.idOf('club')]);
    expect((await moved()).ok).toBe(false);
    expect(await k.row(p, 'sauna')).toBeNull();
  });

  it('a live child under a past-due enforcing parent is not inside it', async () => {
    const k = await gym('past-due-parent');
    await edit(k, 'pool', 'max_stay_minutes = NULL');
    const p = await k.pass();
    await k.enter(p, 'gym');
    k.clock.advance(MIN);
    await k.enter(p, 'pool');
    k.clock.advance(119 * MIN);
    expect(await k.enter(p, 'sauna')).toMatchObject({ ok: false, reason: 'not_inside' });
  });

  it("another org's pass cannot be tapped out, even with a row", async () => {
    const k = await gym('exit-tenant');
    const other = await occupancyKit('exit-tenant-b');
    const stranger = await other.pass();
    await run(
      k.db,
      `INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at,
         last_scan_id) VALUES (?, ?, ?, 'in', 1, 1, 1, 1, 'seed')`,
      [stranger, k.orgId, k.place('gym')],
    );
    expect((await k.exit(stranger, 'gym')).ok).toBe(false);
    expect((await k.row(stranger, 'gym'))?.state).toBe('in');
  });

  it('the cron or the desk closes a place as given: archived, untracked and every row below', async () => {
    const k = await gym('as-given');
    const p = await k.pass();
    await k.enter(p, 'gym');
    const into = await k.enter(p, 'sauna', { waivers: { parent: true } });
    await edit(k, 'pool', "occupancy = 'off', max_stay_minutes = NULL");
    await edit(k, 'gym', 'archived_at = 5');
    const close = await k.planExit(p, 'gym', { asGiven: true, lastScanId: into.scanId });
    expect((await close()).ok).toBe(false);
    const gymRow = await k.row(p, 'gym');
    const cron = await k.planExit(p, 'gym', { asGiven: true, lastScanId: gymRow?.last_scan_id });
    expect((await cron()).ok).toBe(true);
    for (const z of ['gym', 'pool', 'sauna']) expect((await k.row(p, z))?.state, z).toBe('out');
  });
});

import { describe, expect, it } from 'vitest';
import { occupancyKit } from './occupancy-test-fixtures.ts';

/** SA §20.15 races: D1 runs batches one after another, and every rule is inside the statement. */
describe('occupancy races', () => {
  it('two doors at once: one entry, one Already in', async () => {
    const k = await occupancyKit('doors');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120 });
    const p = await k.pass();
    const doors = [await k.planEntry(p, 'gym'), await k.planEntry(p, 'gym')];
    const results = await Promise.all(doors.map((d) => d()));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(['still_inside']);
    expect(await k.inside('gym')).toBe(1);
    expect((await k.revs())[k.place('gym')]).toBe(1);
  });

  it('enter versus exit ends in one of the two orders, never a double state', async () => {
    const k = await occupancyKit('in-out');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120 });
    const p = await k.pass();
    expect((await k.enter(p, 'gym')).ok).toBe(true);
    k.clock.advance(60_000);
    const [entry, exit] = await Promise.all([
      (await k.planEntry(p, 'gym'))(),
      (await k.planExit(p, 'gym'))(),
    ]);
    const state = (await k.row(p, 'gym'))?.state;
    expect(exit.ok).toBe(true);
    // Entry first: held, then out. Exit first: out, then back in.
    if (entry.ok) expect(state).toBe('in');
    else {
      expect(entry.reason).toBe('still_inside');
      expect(state).toBe('out');
    }
  });

  it('ten passes at the last five places of 25: exactly 25 inside', async () => {
    const k = await occupancyKit('cap');
    await k.zone('pool', { capacity: 25 });
    for (const p of await k.passes(20)) expect((await k.enter(p, 'pool')).ok).toBe(true);
    const racers = await k.passes(10);
    const planned = await Promise.all(racers.map((p) => k.planEntry(p, 'pool')));
    const results = await Promise.all(planned.map((d) => d()));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(new Set(results.flatMap((r) => (r.ok ? [] : [r.reason])))).toEqual(
      new Set(['capacity_full']),
    );
    expect(await k.inside('pool')).toBe(25);
  });

  it('a test pass never takes a live place', async () => {
    const k = await occupancyKit('cap-mode');
    await k.zone('pool', { capacity: 1 });
    expect((await k.enter(await k.pass('test'), 'pool', { mode: 'test' })).ok).toBe(true);
    expect((await k.enter(await k.pass(), 'pool')).ok).toBe(true);
    const full = await k.enter(await k.pass(), 'pool');
    expect(full).toMatchObject({ ok: false, reason: 'capacity_full' });
  });

  it('a pass of another mode or org neither enters nor taps out', async () => {
    const k = await occupancyKit('tenant');
    const other = await occupancyKit('tenant-b');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120 });
    const test = await k.pass('test');
    expect((await k.enter(test, 'gym')).ok).toBe(false);
    expect((await k.enter(await other.pass(), 'gym')).ok).toBe(false);
    expect((await k.enter(test, 'gym', { mode: 'test' })).ok).toBe(true);
    expect((await k.exit(test, 'gym')).ok).toBe(false);
    expect((await k.row(test, 'gym'))?.state).toBe('in');
  });

  it('a parent exit racing a child entry leaves no child inside an empty parent', async () => {
    const k = await occupancyKit('nest-race');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120 });
    await k.zone('pool', { parent: 'gym', max_stay_minutes: 60 });
    const p = await k.pass();
    expect((await k.enter(p, 'gym')).ok).toBe(true);
    k.clock.advance(60_000);
    const [exit, entry] = await Promise.all([
      (await k.planExit(p, 'gym'))(),
      (await k.planEntry(p, 'pool'))(),
    ]);
    expect(exit.ok).toBe(true);
    if (!entry.ok) expect(entry.reason).toBe('not_inside');
    // Either order ends with both out: the pool entry's parent check is inside its statement.
    expect((await k.row(p, 'gym'))?.state).toBe('out');
    expect((await k.row(p, 'pool'))?.state ?? 'out').toBe('out');
  });

  it('a child street door at a full tracked parent answers the parent full', async () => {
    const k = await occupancyKit('parent-full');
    await k.zone('club', { capacity: 1 });
    await k.zone('pool', { parent: 'club' });
    expect((await k.enter(await k.pass(), 'club')).ok).toBe(true);
    const p = await k.pass();
    expect(await k.enter(p, 'pool')).toMatchObject({ ok: false, reason: 'capacity_full' });
    expect(await k.row(p, 'pool')).toBeNull();
    // Already inside the parent: it is not counted again.
    const q = await k.pass();
    await k.enter(q, 'club', { waivers: { cap: true } });
    expect((await k.enter(q, 'pool')).ok).toBe(true);
  });
});

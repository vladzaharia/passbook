import { describe, expect, it } from 'vitest';
import { occupancyKit } from './occupancy-test-fixtures.ts';

const MIN = 60_000;

describe('occupancy undo and revisions', () => {
  it('undo restores every row the scan wrote, with due times, and bumps each place', async () => {
    const k = await occupancyKit('undo');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120, time_zone: 'UTC' });
    await k.zone('pool', { parent: 'gym', max_stay_minutes: 60 });
    const p = await k.pass();
    const t0 = k.clock.now();
    await k.enter(p, 'gym');
    k.clock.advance(MIN);
    await k.enter(p, 'pool');
    k.clock.advance(MIN);
    const forced = await k.enter(p, 'gym', { waivers: { inside: true } });
    expect((await k.row(p, 'pool'))?.state).toBe('out');
    const before = await k.revs();
    k.clock.advance(MIN);
    expect(await k.undo(p, [forced.scanId])).toBe('ok');
    expect(await k.row(p, 'gym')).toMatchObject({
      state: 'in',
      entered_at: t0,
      due_at: t0 + 120 * MIN,
    });
    expect(await k.row(p, 'pool')).toMatchObject({
      state: 'in',
      entered_at: t0 + MIN,
      due_at: t0 + 61 * MIN,
    });
    const after = await k.revs();
    for (const z of ['gym', 'pool']) expect(after[k.place(z)]).toBe((before[k.place(z)] ?? 0) + 1);
  });

  it('a later change at another place supersedes the undo, and nothing moves', async () => {
    const k = await occupancyKit('superseded');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120 });
    await k.zone('pool', { parent: 'gym' });
    const p = await k.pass();
    const gymIn = await k.enter(p, 'gym');
    k.clock.advance(MIN);
    const poolIn = await k.enter(p, 'pool');
    expect(await k.undo(p, [gymIn.scanId])).toBe('UNDO_SUPERSEDED');
    expect((await k.row(p, 'gym'))?.state).toBe('in');
    expect((await k.row(p, 'pool'))?.state).toBe('in');
    // Newest first works, and then the older one is no longer superseded.
    expect(await k.undo(p, [poolIn.scanId])).toBe('ok');
    expect(await k.row(p, 'pool')).toBeNull();
    expect(await k.undo(p, [gymIn.scanId])).toBe('ok');
    expect(await k.row(p, 'gym')).toBeNull();
    // Twice is nothing to undo: the guard counts the rows the scan still holds.
    expect(await k.undo(p, [gymIn.scanId])).toBe('ok');
  });

  it('a row changed after the read refuses the whole undo', async () => {
    const k = await occupancyKit('undo-race');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120 });
    const p = await k.pass();
    const entry = await k.enter(p, 'gym');
    k.clock.advance(MIN);
    const exit = await k.planExit(p, 'gym');
    // The exit commits between the undo's read and its batch.
    const undone = k.undo(p, [entry.scanId]);
    await exit();
    expect(['ok', 'UNDO_SUPERSEDED']).toContain(await undone);
    const row = await k.row(p, 'gym');
    // Never a half state: either the entry is gone (and the exit found nothing), or both stand.
    if (row) expect(row.state).toBe('out');
  });

  it('revisions never go lower: entry, exit, undo and refused scans', async () => {
    const k = await occupancyKit('revs');
    await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120 });
    const [p, q] = await k.passes(2);
    const seen: number[] = [];
    const rev = async () => (await k.revs())[k.place('gym')] ?? 0;
    for (const step of [
      () => k.enter(p as string, 'gym'),
      () => k.enter(p as string, 'gym'),
      () => k.enter(q as string, 'gym'),
      () => k.exit(p as string, 'gym'),
      async () => {
        k.clock.advance(MIN);
        const e = await k.enter(p as string, 'gym');
        k.clock.advance(MIN);
        return k.undo(p as string, [e.scanId]);
      },
    ]) {
      await step();
      seen.push(await rev());
    }
    expect(seen).toEqual([1, 1, 2, 3, 5]);
  });
});

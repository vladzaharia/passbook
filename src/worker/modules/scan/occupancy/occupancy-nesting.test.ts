import { describe, expect, it } from 'vitest';
import { occupancyKit } from './occupancy-test-fixtures.ts';

const MIN = 60_000;

/** Northside Gym: Gym (Require tap out) > Pool (Track) > Sauna (Track). */
async function gym(label: string) {
  const k = await occupancyKit(label);
  await k.zone('gym', { occupancy: 'enforce', max_stay_minutes: 120, time_zone: 'UTC' });
  await k.zone('pool', { parent: 'gym', max_stay_minutes: 60 });
  await k.zone('sauna', { parent: 'pool', max_stay_minutes: 30 });
  return k;
}

describe('nested zones', () => {
  it('entering a child needs the enforcing parent; implied rows get their own due times', async () => {
    const k = await gym('implied');
    const p = await k.pass();
    expect(await k.enter(p, 'pool')).toMatchObject({ ok: false, reason: 'not_inside' });
    const t0 = k.clock.now();
    expect((await k.enter(p, 'gym')).ok).toBe(true);
    k.clock.advance(10 * MIN);
    expect((await k.enter(p, 'sauna')).ok).toBe(true);
    expect((await k.row(p, 'gym'))?.due_at).toBe(t0 + 120 * MIN);
    expect((await k.row(p, 'pool'))?.due_at).toBe(t0 + 70 * MIN);
    expect((await k.row(p, 'sauna'))?.due_at).toBe(t0 + 40 * MIN);
  });

  it('a parent waiver enters every tracked ancestor, each with its own due time', async () => {
    const k = await gym('waived');
    const p = await k.pass();
    const t0 = k.clock.now();
    expect((await k.enter(p, 'sauna', { waivers: { parent: true } })).ok).toBe(true);
    expect(await k.row(p, 'gym')).toMatchObject({ state: 'in', due_at: t0 + 120 * MIN });
    expect(await k.row(p, 'pool')).toMatchObject({ state: 'in', due_at: t0 + 60 * MIN });
    expect(await k.row(p, 'sauna')).toMatchObject({ state: 'in', due_at: t0 + 30 * MIN });
  });

  it('leaving a parent leaves every zone below it', async () => {
    const k = await gym('leave');
    const p = await k.pass();
    await k.enter(p, 'gym');
    await k.enter(p, 'sauna');
    expect((await k.exit(p, 'gym')).ok).toBe(true);
    for (const z of ['gym', 'pool', 'sauna']) expect((await k.row(p, z))?.state, z).toBe('out');
    expect(await k.exit(p, 'gym')).toMatchObject({ ok: false, reason: 'not_inside' });
  });

  it('a row past due reads as out: re-entered without Already in, and its children leave', async () => {
    const k = await gym('due');
    const p = await k.pass();
    await k.enter(p, 'gym');
    k.clock.advance(5 * MIN);
    await k.enter(p, 'pool');
    k.clock.advance(116 * MIN);
    // Gym is past due (the cron has not run); the pool row is too, the sauna never entered.
    expect(await k.inside('gym')).toBe(0);
    expect(await k.exit(p, 'gym')).toMatchObject({ ok: false, reason: 'not_inside' });
    const again = await k.enter(p, 'gym');
    expect(again.ok).toBe(true);
    expect(await k.row(p, 'gym')).toMatchObject({ state: 'in', entered_at: k.clock.now() });
    expect((await k.row(p, 'pool'))?.state).toBe('out');
  });

  it('a track-only repeat keeps since; a forced re-entry resets it and sends children out', async () => {
    const k = await gym('repeat');
    await k.zone('lounge', { max_stay_minutes: 60 });
    const p = await k.pass();
    const t0 = k.clock.now();
    await k.enter(p, 'lounge');
    k.clock.advance(5 * MIN);
    expect((await k.enter(p, 'lounge')).ok).toBe(true);
    expect(await k.row(p, 'lounge')).toMatchObject({ entered_at: t0, due_at: t0 + 60 * MIN });
    await k.enter(p, 'gym');
    await k.enter(p, 'pool');
    expect(await k.enter(p, 'gym')).toMatchObject({ ok: false, reason: 'still_inside' });
    const forced = await k.enter(p, 'gym', { waivers: { inside: true } });
    expect(forced.ok).toBe(true);
    expect(await k.row(p, 'gym')).toMatchObject({ entered_at: k.clock.now() });
    expect((await k.row(p, 'pool'))?.state).toBe('out');
  });

  it('the re-entry wait holds an entry until it passes, unless waived', async () => {
    const k = await occupancyKit('wait');
    await k.zone('pool');
    const p = await k.pass();
    await k.enter(p, 'pool');
    await k.exit(p, 'pool');
    k.clock.advance(MIN);
    expect(await k.enter(p, 'pool', { waitMs: 10 * MIN })).toMatchObject({
      ok: false,
      reason: 'cooldown',
    });
    expect((await k.enter(p, 'pool', { waitMs: 10 * MIN, waivers: { wait: true } })).ok).toBe(true);
  });
});

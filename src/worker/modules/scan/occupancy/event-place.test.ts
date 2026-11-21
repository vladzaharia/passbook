import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { first, run } from '../../../platform/db.ts';
import { eventPlaceKit } from './event-place-test-fixtures.ts';
import { countsRead, runReads } from './repo-reads.ts';

let t: Awaited<ReturnType<typeof eventPlaceKit>>;
beforeAll(async () => {
  t = await eventPlaceKit();
});
beforeEach(() => t.kit.clock.set(t.baseline));

describe('a re-entry event is a place', () => {
  it('a plain ticket scans in and out, and the answer names the event place', async () => {
    const e = await t.event({ capacity: 5 });
    const door = await t.door(e.id, 'both');
    const p = await t.pass();
    const entered = await t.act(door, p);
    expect(entered).toMatchObject({
      kind: 'ok',
      occupancy: {
        place: { kind: 'event', id: e.id },
        direction: 'in',
        state: 'in',
        inNow: 1,
        capacity: 5,
      },
    });
    expect(await t.row(p, e.id)).toMatchObject({ state: 'in', tracking: 1, due_at: null });
    t.kit.clock.advance(180_000);
    const left = await t.act(door, p);
    expect(left).toMatchObject({
      kind: 'ok',
      occupancy: { direction: 'out', state: 'out', inNow: 0, stayMs: 180_000 },
    });
    expect(await t.row(p, e.id)).toMatchObject({ state: 'out', tracking: 1 });
  });

  it('an in door holds a second entry as still_inside; an out door holds a pass that is not in', async () => {
    const e = await t.event();
    const inDoor = await t.door(e.id, 'in');
    const outDoor = await t.door(e.id, 'out');
    const p = await t.pass();
    expect(await t.act(outDoor, p)).toMatchObject({ kind: 'heads_up', reason: 'not_inside' });
    expect(await t.act(inDoor, p)).toMatchObject({ kind: 'ok' });
    expect(await t.act(inDoor, p)).toMatchObject({
      kind: 'heads_up',
      reason: 'still_inside',
      occupancy: { place: { kind: 'event' }, state: 'in' },
    });
    expect(await t.act(outDoor, p)).toMatchObject({ kind: 'ok', occupancy: { direction: 'out' } });
    expect(await t.act(inDoor, p)).toMatchObject({ kind: 'ok' });
  });

  it('Auto holds a flip under two minutes old, then lets it through', async () => {
    const e = await t.event();
    const door = await t.door(e.id, 'both');
    const p = await t.pass();
    expect((await t.act(door, p)).kind).toBe('ok');
    expect(await t.act(door, p)).toMatchObject({
      kind: 'heads_up',
      occupancy: { turnaround: 'out' },
    });
    t.kit.clock.advance(121_000);
    expect(await t.act(door, p)).toMatchObject({ kind: 'ok', occupancy: { direction: 'out' } });
  });

  it('a ticket the event took in before cutover (untracked row) can leave and leaves tracked', async () => {
    const e = await t.event();
    const out = await t.door(e.id, 'out');
    const p = await t.pass();
    const now = t.kit.clock.now();
    await run(
      t.kit.env.DB,
      `INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at, last_scan_id)
       VALUES (?, ?, ?, 'in', 0, ?, ?, ?, 'legacy')`,
      [p.id, t.kit.org.id, `event:${e.id}`, now, now, now],
    );
    expect(await t.act(out, p)).toMatchObject({ kind: 'ok', occupancy: { direction: 'out' } });
    expect(await t.row(p, e.id)).toMatchObject({ state: 'out', tracking: 1 });
  });

  it('capacity counts who is inside: a pass that left frees its place', async () => {
    const e = await t.event({ capacity: 1 });
    const inDoor = await t.door(e.id, 'in');
    const outDoor = await t.door(e.id, 'out');
    const [a, b] = [await t.pass(), await t.pass()];
    expect((await t.act(inDoor, a)).kind).toBe('ok');
    expect(await t.act(inDoor, b)).toMatchObject({
      kind: 'heads_up',
      reason: 'capacity_full',
      occupancy: { inNow: 1, capacity: 1 },
    });
    expect((await t.act(outDoor, a)).kind).toBe('ok');
    expect((await t.act(inDoor, b)).kind).toBe('ok');
    // The pass that left comes back only if there is room.
    expect(await t.act(inDoor, a)).toMatchObject({ reason: 'capacity_full' });
  });

  it('a pass already inside is never held by capacity', async () => {
    const e = await t.event({ capacity: 1 });
    const inDoor = await t.door(e.id, 'in');
    const p = await t.pass();
    expect((await t.act(inDoor, p)).kind).toBe('ok');
    await run(t.kit.env.DB, 'UPDATE scan_events SET capacity=1 WHERE id=?', [e.id]);
    expect(await t.act(inDoor, p)).toMatchObject({ reason: 'still_inside' });
  });

  it('In now counts an event as the scanner does, with a retained pass', async () => {
    const e = await t.event();
    const inDoor = await t.door(e.id, 'in');
    const [a, b] = [await t.pass(), await t.pass()];
    await t.act(inDoor, a);
    await t.act(inDoor, b);
    await run(t.kit.env.DB, 'UPDATE passes SET deleted_at=1 WHERE id=?', [a.id]);
    const outcome = await t.act(inDoor, await t.pass());
    const [res] = await runReads(t.kit.env.DB, [
      countsRead(t.kit.org.id, 'live', [`event:${e.id}`], t.kit.clock.now()),
    ]);
    const n = (res?.results?.[0] as { n: number } | undefined)?.n;
    expect(n).toBe(3);
    expect(outcome).toMatchObject({ occupancy: { inNow: n } });
    expect(
      await first(t.kit.env.DB, 'SELECT rev FROM scan_place_revs WHERE place=?', [`event:${e.id}`]),
    ).toMatchObject({ rev: 3 });
  });

  it('a daily ticket is let in on day 2 even if it never left, and once a day otherwise', async () => {
    const daily = await t.kit.scanTemplate('Daily place', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'daily' }],
    });
    const e = await t.event({ templateId: daily });
    await run(t.kit.env.DB, 'UPDATE scan_events SET closes_at=closes_at+864000000 WHERE id=?', [
      e.id,
    ]);
    const inDoor = await t.door(e.id, 'in');
    const outDoor = await t.door(e.id, 'out');
    const [stay, back] = [await t.pass(daily), await t.pass(daily)];
    expect((await t.act(inDoor, stay)).kind).toBe('ok');
    expect(await t.act(inDoor, stay)).toMatchObject({ reason: 'still_inside' });
    expect((await t.act(inDoor, back)).kind).toBe('ok');
    expect((await t.act(outDoor, back)).kind).toBe('ok');
    expect(await t.act(inDoor, back)).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    t.kit.clock.advance(26 * 3_600_000);
    expect((await t.act(inDoor, stay)).kind).toBe('ok');
    expect((await t.act(inDoor, back)).kind).toBe('ok');
  });

  it('a cooldown ticket waits after leaving before it enters again', async () => {
    const slow = await t.kit.scanTemplate('Cooldown place', {
      actions: [
        {
          id: 'check_in',
          label: 'Check in',
          kind: 'check_in',
          repeat: 'cooldown',
          cooldownMinutes: 5,
        },
      ],
    });
    const e = await t.event({ templateId: slow });
    const inDoor = await t.door(e.id, 'in');
    const outDoor = await t.door(e.id, 'out');
    const p = await t.pass(slow);
    expect((await t.act(inDoor, p)).kind).toBe('ok');
    expect((await t.act(outDoor, p)).kind).toBe('ok');
    expect(await t.act(inDoor, p)).toMatchObject({ kind: 'heads_up', reason: 'cooldown' });
    t.kit.clock.advance(5 * 60_000 + 1);
    expect((await t.act(inDoor, p)).kind).toBe('ok');
  });
});

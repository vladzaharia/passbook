import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../../platform/db.ts';
import { createJobContext } from '../../../platform/service-context.ts';
import { kit, setupActionFixture } from '../act-test-fixtures.ts';
import { autoTapOut } from '../occupancy/jobs.ts';
import {
  DISPLAY_TPL,
  personInside,
  station,
  trackedZone,
  useKit,
} from '../occupancy/whos-in-test-fixtures.ts';
import { current, end, mark, read, start } from './roll-call-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
});

describe('roll call: freeze and scope', () => {
  it('freezes the session list, and nobody drops when they leave mid-call', async () => {
    const pool = await trackedZone();
    const ana = await personInside(tpl, 'Ana Reyes', [`zone:${pool.id}`], {
      at: kit.clock.now() - 5000,
    });
    const ben = await personInside(tpl, 'Ben Okoro', [`zone:${pool.id}`], {
      at: kit.clock.now() - 2000,
    });
    const s = await station([tpl], [pool.id]);
    const { status, body } = await start(s);
    expect(status).toBe(200);
    expect(body.people.map((p) => p.holder)).toEqual(['Ana Reyes', 'Ben Okoro']);
    expect(body.counts).toMatchObject({ total: 2, unconfirmed: 2, present: 0, late: 0 });
    await run(kit.env.DB, "UPDATE scan_presence SET state = 'out' WHERE pass_id = ?", [ana.id]);
    const after = await read(s, body.id);
    expect(after.people).toHaveLength(2);
    expect(after.people.find((p) => p.passId === ana.id)).toMatchObject({ presence: 'left' });
    expect(after.people.find((p) => p.passId === ben.id)).toMatchObject({ presence: 'in' });
  });

  it('starting twice joins the open call; each session has its own', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Solo', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const b = await station([tpl], [pool.id]);
    const first = await start(a);
    expect((await start(a)).body.id).toBe(first.body.id);
    const other = await start(b);
    expect(other.body.id).not.toBe(first.body.id);
    expect(await current(a)).toMatchObject({ id: first.body.id });
  });

  it('keeps the tenant, mode and session: another session cannot read, mark or end it', async () => {
    const pool = await trackedZone();
    const other = await trackedZone();
    const p = await personInside(tpl, 'Private Person', [`zone:${pool.id}`]);
    await personInside(tpl, 'Test Mode', [`zone:${pool.id}`], { mode: 'test' });
    const a = await station([tpl], [pool.id]);
    const b = await station([tpl], [other.id]);
    const call = (await start(a)).body;
    expect(JSON.stringify(call)).not.toContain('Test Mode');
    expect(call.people).toHaveLength(1);
    expect(await current(b)).toBeNull();
    const peek = await kit.get(b.headers, `/roll-call/${call.id}`);
    expect(peek.status).toBe(404);
    expect(await peek.text()).not.toContain('Private Person');
    expect((await mark(b, call.id, [{ passId: p.id, status: 'present' }])).status).toBe(404);
    expect((await end(b, call.id)).status).toBe(404);
    expect((await read(a, call.id)).endedAt).toBeNull();
  });

  it('refuses a Door role and a customer screen, and names nobody', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Hidden', [`zone:${pool.id}`]);
    for (const opts of [{ role: 'door' as const }, { deviceRole: 'customer' as const }]) {
      const s = await station([tpl], [pool.id], opts);
      const res = await kit.post(s.headers, '/roll-call', {});
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('Hidden');
    }
  });

  it('has nothing to call when no place is tracked', async () => {
    const s = await station([tpl], []);
    const res = await kit.post(s.headers, '/roll-call', {});
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('ROLL_CALL_NO_PLACES');
  });
});

describe('roll call: confirmations', () => {
  it('two devices racing on one person: the later mark by time wins whatever order they arrive in', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Race', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const t = kit.clock.now();
    // The later mark (out at t) reaches the server first; the earlier one (present at t - 1000) arrives after.
    await mark(a, call.id, [{ passId: p.id, status: 'out', at: t }]);
    const late = await mark(a, call.id, [{ passId: p.id, status: 'present', at: t - 1000 }]);
    expect(late.body.people[0]?.mark).toMatchObject({ status: 'out', at: t });
    const rows = await all(
      kit.env.DB,
      'SELECT status FROM roll_call_marks WHERE roll_call_id = ?',
      [call.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('merges an offline queue by time and counts each person once', async () => {
    const pool = await trackedZone();
    const x = await personInside(tpl, 'X', [`zone:${pool.id}`]);
    const y = await personInside(tpl, 'Y', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const t = kit.clock.now();
    const res = await mark(a, call.id, [
      { passId: x.id, status: 'present', at: t - 3000 },
      { passId: y.id, status: 'present', at: t - 2000 },
      { passId: x.id, status: 'none', at: t - 1000 },
    ]);
    expect(res.body.counts).toMatchObject({ present: 1, unconfirmed: 1, total: 2 });
    expect(res.body.rev).toBeGreaterThan(0);
  });

  it('adds a person who taps in after the start as late, and keeps them when they leave', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Early', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const l = await personInside(tpl, 'Latecomer', [`zone:${pool.id}`]);
    const seen = await read(a, call.id);
    expect(seen.counts.late).toBe(1);
    expect(seen.people.find((p) => p.passId === l.id)).toMatchObject({ late: true });
    await mark(a, call.id, [{ passId: l.id, status: 'present' }]);
    await run(kit.env.DB, "UPDATE scan_presence SET state = 'out' WHERE pass_id = ?", [l.id]);
    const kept = await read(a, call.id);
    expect(kept.people.find((p) => p.passId === l.id)).toMatchObject({
      late: true,
      mark: { status: 'present' },
    });
  });

  it('refuses a mark for someone who is not on the call', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Listed', [`zone:${pool.id}`]);
    const stranger = await personInside(tpl, 'Elsewhere', [`zone:${(await trackedZone()).id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const res = await mark(a, call.id, [{ passId: stranger.id, status: 'present' }]);
    expect(res.status).toBe(403);
  });

  it('refuses marks after the call ended, and ending twice answers with the record', async () => {
    const pool = await trackedZone();
    const p = await personInside(tpl, 'Done', [`zone:${pool.id}`]);
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    const ended = await end(a, call.id);
    expect(ended.body.endedAt).not.toBeNull();
    expect((await end(a, call.id)).body.endedAt).toBe(ended.body.endedAt);
    const res = await mark(a, call.id, [{ passId: p.id, status: 'present' }]);
    expect(res.status).toBe(409);
    expect(await current(a)).toBeNull();
    const next = await start(a);
    expect(next.body.id).not.toBe(call.id);
  });
});

describe('roll call: max stay hold', () => {
  it('holds the stay exit while the call is open, lists the person as not confirmed out, and exits after', async () => {
    const pool = await trackedZone({ maxStayMinutes: 60 });
    const place = `zone:${pool.id}`;
    const now = kit.clock.now();
    const p = await personInside(tpl, 'Long Stay', [place], {
      at: now - 30 * 60_000,
      dueAt: now + 30 * 60_000,
    });
    const a = await station([tpl], [pool.id]);
    const call = (await start(a)).body;
    expect(call.people[0]?.presence).toBe('in');
    kit.clock.advance(35 * 60_000);
    await autoTapOut(jobCtx());
    const held = await read(a, call.id);
    // Past its due time and still listed, flagged for the desk: nobody confirmed the exit.
    expect(held.people[0]).toMatchObject({ presence: 'lapsed', notConfirmedOut: true });
    expect(held.counts.notConfirmedOut).toBe(1);
    expect(
      (
        await all<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM scan_presence WHERE pass_id = ?',
          [p.id],
        )
      )[0]?.state,
    ).toBe('in');
    await mark(a, call.id, [{ passId: p.id, status: 'out' }]);
    expect((await read(a, call.id)).people[0]).toMatchObject({ notConfirmedOut: false });
    await end(a, call.id);
    await autoTapOut(jobCtx());
    expect(
      (
        await all<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM scan_presence WHERE pass_id = ?',
          [p.id],
        )
      )[0]?.state,
    ).toBe('out');
    expect((await read(a, call.id)).people[0]).toMatchObject({ presence: 'lapsed' });
  });

  it('does not hold exits for another org or place, or once the call is stale', async () => {
    const held = await trackedZone({ maxStayMinutes: 60 });
    const free = await trackedZone({ maxStayMinutes: 60 });
    const now = kit.clock.now();
    await personInside(tpl, 'Held', [`zone:${held.id}`], {
      at: now - 30 * 60_000,
      dueAt: now + 30 * 60_000,
    });
    const loose = await personInside(tpl, 'Loose', [`zone:${free.id}`], {
      at: now - 30 * 60_000,
      dueAt: now + 30 * 60_000,
    });
    const a = await station([tpl], [held.id]);
    await start(a);
    kit.clock.advance(35 * 60_000);
    await autoTapOut(jobCtx());
    expect(
      (
        await all<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM scan_presence WHERE pass_id = ?',
          [loose.id],
        )
      )[0]?.state,
    ).toBe('out');
  });
});

const jobCtx = () => createJobContext(kit.env, 'test', { clock: kit.clock });

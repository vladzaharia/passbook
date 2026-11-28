import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, run } from '../../../platform/db.ts';
import { beforeBatch } from '../batch-interceptor-test-support.ts';
import { RACE_PRESENCE_WRITE } from '../race-tags.ts';
import { codeOf, key } from '../test-kit.ts';
import { eventPlaceKit } from './event-place-test-fixtures.ts';

let t: Awaited<ReturnType<typeof eventPlaceKit>>;
beforeAll(async () => {
  t = await eventPlaceKit();
});
beforeEach(() => t.kit.clock.set(t.baseline));

const gates = (passId: string) =>
  all<{ state: string }>(t.kit.env.DB, 'SELECT state FROM scan_gates WHERE pass_id=?', [passId]);

describe('event place races', () => {
  it('two doors at once for the last place: one ok, the other is Event full', async () => {
    const e = await t.event({ capacity: 1 });
    const [a, b] = [await t.door(e.id), await t.door(e.id)];
    const [p, q] = [await t.pass(), await t.pass()];
    const results = await Promise.all([t.act(a, p), t.act(b, q)]);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    const lost = results.find((r) => r.kind !== 'ok');
    expect(lost).toMatchObject({ kind: 'heads_up', reason: 'capacity_full' });
    expect(await t.inside(e.id)).toBe(1);
  });

  it('a rival fills the last place after the loser read it free: the loser names capacity_full', async () => {
    const e = await t.event({ capacity: 1 });
    const [a, b] = [await t.door(e.id), await t.door(e.id)];
    const [winner, loser] = [await t.pass(), await t.pass()];
    let rival: Awaited<ReturnType<typeof t.act>> | undefined;
    const { result, fired } = await beforeBatch(
      t.kit.env,
      RACE_PRESENCE_WRITE,
      async () => {
        rival = await t.act(a, winner);
      },
      () => t.act(b, loser),
    );
    expect(fired).toBe(true);
    expect(rival?.kind).toBe('ok');
    expect(result).toMatchObject({ kind: 'heads_up', reason: 'capacity_full' });
    expect(await t.row(loser, e.id)).toBeNull();
    expect(await gates(loser.id)).toEqual([]);
    expect(await t.inside(e.id)).toBe(1);
  });

  it('the same pass at two doors: the loser says still_inside, not a generic reason', async () => {
    const e = await t.event({ capacity: 5 });
    const [a, b] = [await t.door(e.id), await t.door(e.id)];
    const p = await t.pass();
    let rival: Awaited<ReturnType<typeof t.act>> | undefined;
    const { result } = await beforeBatch(
      t.kit.env,
      RACE_PRESENCE_WRITE,
      async () => {
        rival = await t.act(a, p);
      },
      () => t.act(b, p),
    );
    expect(rival?.kind).toBe('ok');
    expect(result).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
    expect(await t.inside(e.id)).toBe(1);
  });

  it('an exit racing an exit: one leaves, the other is not_inside', async () => {
    const e = await t.event();
    const inDoor = await t.door(e.id, 'in');
    const [a, b] = [await t.door(e.id, 'out'), await t.door(e.id, 'out')];
    const p = await t.pass();
    expect((await t.act(inDoor, p)).kind).toBe('ok');
    let rival: Awaited<ReturnType<typeof t.act>> | undefined;
    const { result } = await beforeBatch(
      t.kit.env,
      RACE_PRESENCE_WRITE,
      async () => {
        rival = await t.act(a, p);
      },
      () => t.act(b, p),
    );
    expect(rival?.kind).toBe('ok');
    expect(result).toMatchObject({ kind: 'heads_up', reason: 'not_inside' });
    expect(await t.inside(e.id)).toBe(0);
  });

  it('a rival that enters and leaves after the loser read cannot be overwritten (no ABA)', async () => {
    const e = await t.event();
    const [a, out, b] = [await t.door(e.id), await t.door(e.id, 'out'), await t.door(e.id)];
    const p = await t.pass();
    let exit: Awaited<ReturnType<typeof t.act>> | undefined;
    const { result } = await beforeBatch(
      t.kit.env,
      RACE_PRESENCE_WRITE,
      async () => {
        await t.act(a, p);
        exit = await t.act(out, p);
      },
      () => t.act(b, p),
    );
    expect(exit?.kind).toBe('ok');
    expect(result.kind).toBe('heads_up');
    expect(await t.row(p, e.id)).toMatchObject({ state: 'out', last_scan_id: exit?.scanId });
  });

  it('an undo frees the last place a door was about to find full', async () => {
    const e = await t.event({ capacity: 1 });
    const [a, b] = [await t.door(e.id), await t.door(e.id)];
    const [first, second] = [await t.pass(), await t.pass()];
    const entered = await t.act(a, first);
    const { result } = await beforeBatch(
      t.kit.env,
      RACE_PRESENCE_WRITE,
      async () => {
        const res = await t.kit.post(a.headers, `/scans/${entered.scanId}/undo`, {
          idempotencyKey: key(),
        });
        expect(res.status).toBe(200);
      },
      () => t.act(b, second),
    );
    expect(result.kind).toBe('ok');
    expect(await t.inside(e.id)).toBe(1);
  });

  it('a config change between the read and the commit refuses the admission', async () => {
    const e = await t.event({ capacity: 1 });
    const door = await t.door(e.id);
    const p = await t.pass();
    const { result } = await beforeBatch(
      t.kit.env,
      RACE_PRESENCE_WRITE,
      async (db) => {
        await run(db, 'UPDATE scan_events SET capacity=9 WHERE id=?', [e.id]);
      },
      () =>
        t.kit.post(door.headers, '/actions', {
          input: codeOf(p),
          idempotencyKey: key(),
          clientTs: t.kit.clock.now(),
          actionId: 'check_in',
        }),
    );
    expect(result.status).not.toBe(200);
    expect(await t.row(p, e.id)).toBeNull();
  });

  it('an undo after a config change still restores the place', async () => {
    const e = await t.event({ capacity: 5 });
    const door = await t.door(e.id);
    const p = await t.pass();
    const entered = await t.act(door, p);
    await run(t.kit.env.DB, 'UPDATE scan_events SET capacity=9, hard_limit=1 WHERE id=?', [e.id]);
    const res = await t.kit.post(door.headers, `/scans/${entered.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(res.status).toBe(200);
    expect(await t.inside(e.id)).toBe(0);
  });
});

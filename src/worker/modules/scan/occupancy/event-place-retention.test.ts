import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { first } from '../../../platform/db.ts';
import {
  clearScanRetentionDeleteStmt,
  stageScanRetentionDeleteStmt,
} from '../repo-scan-retention.ts';
import { prepareScanRetentionDelete } from '../scan-retention-proof.ts';
import { key } from '../test-kit.ts';
import { eventPlaceKit, type Pass } from './event-place-test-fixtures.ts';

let t: Awaited<ReturnType<typeof eventPlaceKit>>;
beforeAll(async () => {
  t = await eventPlaceKit();
});
beforeEach(() => t.kit.clock.set(t.baseline));

/** Hard-delete a pass the way retention does: staged proof, delete, cleared stage. */
async function hardDelete(pass: Pass) {
  const db = t.kit.env.DB;
  const deletion = await prepareScanRetentionDelete(t.kit.env, pass);
  await db.batch([
    stageScanRetentionDeleteStmt(db, pass.id, deletion),
    db.prepare('DELETE FROM passes WHERE id=?').bind(pass.id),
    clearScanRetentionDeleteStmt(db, deletion),
  ]);
}

const retained = (scanId: string | null | undefined) =>
  first<{ state: string; presence_state: string }>(
    t.kit.env.DB,
    'SELECT state, presence_state FROM scan_retained_gates WHERE scan_id=?',
    [scanId ?? null],
  );

describe('event totals keep a deleted pass the builder moved', () => {
  it('an entry: the deleted pass still fills its place and still counts as arrived', async () => {
    const e = await t.event({ capacity: 1 });
    const door = await t.door(e.id);
    const [a, b] = [await t.pass(), await t.pass()];
    const entered = await t.act(door, a);
    expect(entered.kind).toBe('ok');
    await hardDelete(a);
    expect(await retained(entered.scanId)).toEqual({ state: 'in', presence_state: 'in' });
    expect(await t.act(door, b)).toMatchObject({
      kind: 'heads_up',
      reason: 'capacity_full',
      counts: { event: { arrived: 1 } },
    });
  });

  it('an exit: the deleted pass is arrived but no longer inside', async () => {
    const e = await t.event({ capacity: 1 });
    const inDoor = await t.door(e.id, 'in');
    const outDoor = await t.door(e.id, 'out');
    const [a, b] = [await t.pass(), await t.pass()];
    await t.act(inDoor, a);
    const left = await t.act(outDoor, a);
    expect(left.kind).toBe('ok');
    await hardDelete(a);
    expect(await retained(left.scanId)).toEqual({ state: 'out', presence_state: 'out' });
    expect(await t.act(inDoor, b)).toMatchObject({
      kind: 'ok',
      counts: { event: { arrived: 2, inside: 1 } },
    });
  });

  it('an undone exit: the pass is inside again after deletion', async () => {
    const e = await t.event({ capacity: 1 });
    const inDoor = await t.door(e.id, 'in');
    const outDoor = await t.door(e.id, 'out');
    const [a, b] = [await t.pass(), await t.pass()];
    await t.act(inDoor, a);
    const left = await t.act(outDoor, a);
    const undone = await t.kit.post(outDoor.headers, `/scans/${left.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
    expect(await t.row(a, e.id)).toMatchObject({ state: 'in' });
    await hardDelete(a);
    expect(await t.act(inDoor, b)).toMatchObject({ reason: 'capacity_full' });
  });
});

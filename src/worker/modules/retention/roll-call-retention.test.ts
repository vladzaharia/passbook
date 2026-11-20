import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { placeHold } from './holds.ts';
import { DAY } from './policy.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';
import { sweepClass } from './sweep.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const db = () => rk.kit.env.DB;
const now = () => rk.kit.clock.now();

/** An ended roll call `age` days old with a mark for `passId`. */
async function call(orgId: string, passId: string, age: number) {
  const id = rk.kit.fx.ids.id();
  const at = now() - age * DAY;
  await run(
    db(),
    `INSERT INTO roll_calls (id, org_id, mode, scope_key, places, snapshot, started_by, started_at, ended_at, ended_by)
     VALUES (?, ?, 'live', 'org', '[]', ?, 'Desk', ?, ?, 'Desk')`,
    [id, orgId, JSON.stringify([{ passId, place: 'zone:z', since: at }]), at - 1000, at],
  );
  await run(
    db(),
    `INSERT INTO roll_call_marks (roll_call_id, pass_id, org_id, mode, status, by_name, marked_at)
     VALUES (?, ?, ?, 'live', 'present', 'Desk', ?)`,
    [id, passId, orgId, at],
  );
  return id;
}
const present = async (id: string) =>
  (await all(db(), 'SELECT 1 FROM roll_calls WHERE id = ?', [id])).length === 1;

describe('roll call retention', () => {
  it('ended calls leave with the scans window, marks with them; newer and open calls stay', async () => {
    const o = await rk.org();
    const pass = await rk.kit.pass({ orgId: o.orgId });
    const old = await call(o.orgId, pass.id, 4000);
    const fresh = await call(o.orgId, pass.id, 1);
    const open = rk.kit.fx.ids.id();
    await run(
      db(),
      `INSERT INTO roll_calls (id, org_id, mode, scope_key, places, snapshot, started_by, started_at)
       VALUES (?, ?, 'live', 'open', '[]', '[]', 'Desk', ?)`,
      [open, o.orgId, now() - 4000 * DAY],
    );
    await sweepClass(rk.kit.ctx, 'scans');
    expect(await present(old)).toBe(false);
    expect(
      await all(db(), 'SELECT 1 FROM roll_call_marks WHERE roll_call_id = ?', [old]),
    ).toHaveLength(0);
    expect(await present(fresh)).toBe(true);
    expect(await present(open)).toBe(true);
  });

  it('a hold keeps the call: org-wide, or on a pass that is on it', async () => {
    const held = await rk.org();
    const heldPass = await rk.kit.pass({ orgId: held.orgId });
    const pass = await rk.kit.pass({ orgId: held.orgId });
    const admin = await rk.platform();
    await placeHold(
      rk.kit.ctx,
      held.orgId,
      { passId: heldPass.id, reason: 'dispute' },
      { kind: 'platform', admin },
    );
    const keep = await call(held.orgId, heldPass.id, 4000);
    const drop = await call(held.orgId, pass.id, 4000);
    const orgHeld = await rk.org();
    const orgPass = await rk.kit.pass({ orgId: orgHeld.orgId });
    await placeHold(rk.kit.ctx, orgHeld.orgId, { reason: 'inquiry' }, { kind: 'platform', admin });
    const keepAll = await call(orgHeld.orgId, orgPass.id, 4000);
    await sweepClass(rk.kit.ctx, 'scans');
    expect(await present(keep)).toBe(true);
    expect(await present(drop)).toBe(false);
    expect(await present(keepAll)).toBe(true);
  });

  it('a deleted pass takes its marks with it, and no name is stored on the call', async () => {
    const o = await rk.org();
    const pass = await rk.kit.pass({ orgId: o.orgId });
    const id = await call(o.orgId, pass.id, 1);
    await run(db(), 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(
      await all(db(), 'SELECT 1 FROM roll_call_marks WHERE roll_call_id = ?', [id]),
    ).toHaveLength(0);
    const [row] = await all<{ snapshot: string }>(
      db(),
      'SELECT snapshot FROM roll_calls WHERE id = ?',
      [id],
    );
    expect(Object.keys(JSON.parse(row?.snapshot ?? '[]')[0])).toEqual(['passId', 'place', 'since']);
  });
});

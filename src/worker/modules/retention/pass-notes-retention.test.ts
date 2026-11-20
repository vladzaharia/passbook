import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { dailyScans } from '../scan/jobs.ts';
import { placeHold } from './holds.ts';
import { DAY } from './policy.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';
import { sweepClass } from './sweep.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const db = () => rk.kit.env.DB;

/** A note `age` days old. */
async function note(orgId: string, passId: string, age: number, mode: 'live' | 'test' = 'live') {
  const id = rk.kit.fx.ids.id();
  await run(
    db(),
    `INSERT INTO pass_notes (id, org_id, mode, pass_id, credential_generation, body, author_name, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, 1, 'n', 'Desk', ?, ?)`,
    [id, orgId, mode, passId, id, rk.kit.clock.now() - age * DAY],
  );
  return id;
}
const present = async (id: string) =>
  (await all(db(), 'SELECT 1 FROM pass_notes WHERE id = ?', [id])).length === 1;
const sweep = () => sweepClass(rk.kit.ctx, 'scans', undefined, 'pass_notes');

describe('staff note retention', () => {
  it('notes age with the scans window, one receipt per sweep, and newer notes stay', async () => {
    const o = await rk.org();
    const pass = await rk.kit.pass({ orgId: o.orgId });
    const old = await note(o.orgId, pass.id, 4000);
    const fresh = await note(o.orgId, pass.id, 1);
    await sweep();
    expect(await present(old)).toBe(false);
    expect(await present(fresh)).toBe(true);
    const receipts = await all<{ deleted: number }>(
      db(),
      "SELECT deleted FROM retention_receipts WHERE class = 'scans' AND kind = 'sweep'",
    );
    expect(receipts.map((r) => r.deleted)).toContain(1);
  });

  it('a hold keeps the note: org-wide, or on its pass', async () => {
    const admin = await rk.platform();
    const held = await rk.org();
    const heldPass = await rk.kit.pass({ orgId: held.orgId });
    const otherPass = await rk.kit.pass({ orgId: held.orgId });
    await placeHold(
      rk.kit.ctx,
      held.orgId,
      { passId: heldPass.id, reason: 'dispute' },
      { kind: 'platform', admin },
    );
    const keep = await note(held.orgId, heldPass.id, 4000);
    const drop = await note(held.orgId, otherPass.id, 4000);
    const orgHeld = await rk.org();
    const orgPass = await rk.kit.pass({ orgId: orgHeld.orgId });
    await placeHold(rk.kit.ctx, orgHeld.orgId, { reason: 'inquiry' }, { kind: 'platform', admin });
    const keepAll = await note(orgHeld.orgId, orgPass.id, 4000);
    await sweep();
    expect(await present(keep)).toBe(true);
    expect(await present(drop)).toBe(false);
    expect(await present(keepAll)).toBe(true);
  });

  it('test-mode notes keep the sandbox window, not the retention plan', async () => {
    const o = await rk.org();
    const pass = await rk.kit.pass({ orgId: o.orgId, mode: 'test' });
    const old = await note(o.orgId, pass.id, 4000, 'test');
    const fresh = await note(o.orgId, pass.id, 1, 'test');
    await sweep();
    expect(await present(old)).toBe(true);
    await dailyScans(rk.kit.ctx);
    expect(await present(old)).toBe(false);
    expect(await present(fresh)).toBe(true);
  });
});

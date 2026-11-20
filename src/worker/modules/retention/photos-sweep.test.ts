import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { encoded } from '../passes/member-photo-test-fixtures.ts';
import { placeHold } from './holds.ts';
import { dailyPhotos } from './jobs.ts';
import { DAY } from './policy.ts';
import { readReceipts } from './receipt-service.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const ctx = () => rk.kit.ctx;
const db = () => rk.kit.env.DB;
const system = { type: 'system' as const, id: null };

/** A pass with a stored photo, voided `age` days ago unless `status` says otherwise. */
async function photoPass(orgId: string, age: number, status: 'voided' | 'active' = 'voided') {
  const pass = await rk.kit.pass({ orgId });
  await putMemberPhoto(ctx(), system, pass.id, { png: encoded, includeInPass: false }, orgId);
  const at = rk.kit.clock.now() - age * DAY;
  await run(db(), 'UPDATE passes SET status = ?, modified_at = ? WHERE id = ?', [
    status,
    at,
    pass.id,
  ]);
  await run(db(), 'UPDATE member_photos SET updated_at = ? WHERE pass_id = ?', [at, pass.id]);
  // The test's own UPDATE staged a rollback candidate a real, settled photo would not have.
  await run(db(), 'DELETE FROM pass_transfer_asset_candidates WHERE pass_id = ?', [pass.id]);
  const row = (
    await all<{ r2_key: string }>(db(), 'SELECT r2_key FROM member_photos WHERE pass_id = ?', [
      pass.id,
    ])
  )[0];
  return { id: pass.id, key: row?.r2_key as string };
}
const rowCount = async (passId: string) =>
  (await all(db(), 'SELECT 1 FROM member_photos WHERE pass_id = ?', [passId])).length;
const inR2 = async (key: string) => (await rk.kit.env.BUCKET.head(key)) !== null;

describe('photos sweep', () => {
  it('removes expired photos of voided passes with their objects, and writes a receipt', async () => {
    const o = await rk.org();
    const old = await photoPass(o.orgId, 60);
    const fresh = await photoPass(o.orgId, 5);
    const live = await photoPass(o.orgId, 60, 'active');
    expect(await inR2(old.key)).toBe(true);
    await dailyPhotos(ctx());
    expect(await rowCount(old.id)).toBe(0);
    expect(await inR2(old.key)).toBe(false);
    expect(await rowCount(fresh.id)).toBe(1);
    expect(await rowCount(live.id)).toBe(1);
    const receipts = await readReceipts(ctx(), null, 'photos');
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every((r) => r.verified)).toBe(true);
  });

  it('keeps a held org and a held pass, and sweeps them after release', async () => {
    const heldOrg = await rk.org();
    const orgPhoto = await photoPass(heldOrg.orgId, 60);
    const mixed = await rk.org();
    const heldPass = await photoPass(mixed.orgId, 60);
    const freePass = await photoPass(mixed.orgId, 60);
    const admin = await rk.platform();
    await placeHold(ctx(), heldOrg.orgId, { reason: 'inquiry' }, { kind: 'platform', admin });
    await placeHold(
      ctx(),
      mixed.orgId,
      { passId: heldPass.id, reason: 'dispute' },
      { kind: 'platform', admin },
    );
    await dailyPhotos(ctx());
    expect(await rowCount(orgPhoto.id)).toBe(1);
    expect(await inR2(orgPhoto.key)).toBe(true);
    expect(await rowCount(heldPass.id)).toBe(1);
    expect(await inR2(heldPass.key)).toBe(true);
    expect(await rowCount(freePass.id)).toBe(0);
  });
});

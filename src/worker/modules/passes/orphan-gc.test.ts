import { describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { PASS_OBJECT_GRACE_MS, sweepPassObjects } from './orphan-gc.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { REFERENCED_KEYS_SQL } from './repo-orphan-gc.ts';

const put = (kit: Kit, key: string) => kit.env.BUCKET.put(key, new Uint8Array([1]));
const has = async (kit: Kit, key: string) => (await kit.env.BUCKET.head(key)) !== null;
/** Objects are stamped with the wall clock; the sweep sees them as past the in-flight grace. */
const age = (kit: Kit) => kit.clock.set(Date.now() + PASS_OBJECT_GRACE_MS + 60_000);
const ctxOf = (kit: Kit) => jobCtxOf(kit);

async function version(kit: Kit, passId: string, v: number, key: string | null, purged = false) {
  await run(
    kit.env.DB,
    `INSERT INTO pass_versions (pass_id, version, object_key, template_version, personalization, cause,
       created_at, purged_at) VALUES (?, ?, ?, '1', '{}', 'admin', ?, ?)`,
    [passId, v, key, Date.now(), purged ? Date.now() : null],
  );
}

describe('pass object gc', () => {
  it('keeps head, retained, boundary, in-flight and foreign keys; deletes provable orphans', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const id = pass.id;
    const retained = `passes/${id}/v2-retained.pkpass`;
    const boundary = `passes/${id}/v3-boundary.pkpass`;
    const orphan = `passes/${id}/v4-orphan.pkpass`;
    const preview = `passes/${id}/v5-orphan.preview.json`;
    const foreign = `passes/${id}/asset-logo.png`;
    const voidedCurrent = `passes/${id}/v${pass.version}-voided.pkpass`;
    const voidedRetained = `passes/${id}/v2-voided.pkpass`;
    await version(kit, id, 2, retained);
    await version(kit, id, 3, null, true);
    await run(
      kit.env.DB,
      'INSERT INTO pass_boundaries (pass_id, version, object_key, due_at) VALUES (?, 3, ?, NULL)',
      [id, boundary],
    );
    for (const key of [retained, boundary, orphan, preview, foreign, voidedCurrent, voidedRetained])
      await put(kit, key);
    // A voided copy is kept while its version is retained and goes once the version is purged.
    await version(kit, id, 9, null, true);
    const purgedVoided = `passes/${id}/v9-voided.pkpass`;
    await put(kit, purgedVoided);

    // In-flight: younger than the grace, nothing points at it yet.
    await sweepPassObjects(ctxOf(kit));
    expect(await has(kit, orphan)).toBe(true);

    age(kit);
    await sweepPassObjects(ctxOf(kit));
    expect(await has(kit, pass.objectKey)).toBe(true);
    for (const key of [retained, boundary, foreign, voidedCurrent, voidedRetained])
      expect(await has(kit, key), key).toBe(true);
    for (const key of [orphan, preview, purgedVoided]) expect(await has(kit, key), key).toBe(false);
  });

  it('is bounded per run, continues from its cursor and is idempotent', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const keys = Array.from(
      { length: 600 },
      (_, i) => `passes/${pass.id}/v7-o${String(i).padStart(4, '0')}.pkpass`,
    );
    await Promise.all(keys.map((k) => put(kit, k)));
    age(kit);
    await sweepPassObjects(ctxOf(kit), 1);
    const left = (await Promise.all(keys.map((k) => has(kit, k)))).filter(Boolean).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(600);
    for (let i = 0; i < 5; i++) await sweepPassObjects(ctxOf(kit), 1);
    expect((await Promise.all(keys.map((k) => has(kit, k)))).some(Boolean)).toBe(false);
    expect(await has(kit, pass.objectKey)).toBe(true);
    await sweepPassObjects(ctxOf(kit), 1);
    await sweepPassObjects(ctxOf(kit), 1);
    expect(await has(kit, pass.objectKey)).toBe(true);
  });

  it('keeps keys held by a removal claim, a delivery or a preview version; drops a gone pass voided copy', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const id = pass.id;
    const claim = `passes/${id}/v6-claim.pkpass`;
    const preview = `passes/${id}/v7-held.preview.json`;
    const goneVoided = `passes/gone-${id}/v1-voided.pkpass`;
    await run(kit.env.DB, 'UPDATE passes SET removal_claim_object_key = ? WHERE id = ?', [
      claim,
      id,
    ]);
    await version(kit, id, 7, preview);
    for (const key of [claim, preview, goneVoided]) await put(kit, key);
    age(kit);
    await sweepPassObjects(ctxOf(kit));
    expect(await has(kit, claim)).toBe(true);
    expect(await has(kit, preview)).toBe(true);
    expect(await has(kit, goneVoided)).toBe(false);
    expect(await kit.env.BUCKET.head('sweep/pass-objects-cursor')).toBeNull();
  });

  it('looks keys up through indexes, never a table scan', async () => {
    const kit = await setupKit();
    const plan = await all<{ detail: string }>(
      kit.env.DB,
      `EXPLAIN QUERY PLAN ${REFERENCED_KEYS_SQL}`,
      ['["a"]'],
    );
    const scans = plan
      .map((r) => r.detail)
      .filter((d) => /\bSCAN\b/.test(d) && !/json_each/.test(d));
    expect(scans, plan.map((r) => r.detail).join(' | ')).toEqual([]);
  });
});

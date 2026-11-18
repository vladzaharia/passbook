import { beforeAll, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { headMatches } from './head-store.ts';
import { dailyReceipts } from './jobs.ts';
import { readReceipts, writeReceipt } from './receipt-service.ts';
import { type Anchor, anchorMac, type Receipt, verifyChain } from './receipts.ts';
import { lastReceiptRows } from './repo-receipts.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const ctx = () => rk.kit.ctx;
const YEAR = 365 * 86_400_000;
const sweep = (orgId: string | null, cls: string, deleted: number) =>
  writeReceipt(ctx(), { orgId, cls, kind: 'sweep', policyDays: 90, cutoffAt: 1, deleted });
const at = (ms: number): ServiceContext => ({ ...ctx(), clock: new ManualClock(ms) });
const verdicts = async (orgId: string | null, cls: string) =>
  (await readReceipts(ctx(), orgId, cls)).map((r) => r.verified);

describe('receipt chain', () => {
  it('chains receipts per (org, class) and verifies them', async () => {
    const o = await rk.org();
    const a = await sweep(o.orgId, 'scans', 5);
    const b = await sweep(o.orgId, 'scans', 0);
    const c = await sweep(o.orgId, 'scans', 7);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.prevMac).toBeNull();
    expect(b.prevMac).toBe(a.mac);
    expect(c.prevMac).toBe(b.mac);
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true, true]);
  });

  it('keeps separate chains per org and per class, and one for the platform pass', async () => {
    const [a, b] = [await rk.org(), await rk.org()];
    expect((await sweep(a.orgId, 'scans', 1)).seq).toBe(1);
    expect((await sweep(a.orgId, 'events', 1)).seq).toBe(1);
    expect((await sweep(b.orgId, 'scans', 1)).seq).toBe(1);
    const p1 = await sweep(null, 'photos', 1);
    const p2 = await sweep(null, 'photos', 1);
    expect([p1.seq, p2.seq, p2.orgId]).toEqual([1, 2, null]);
    expect(await verdicts(null, 'photos')).toEqual([true, true]);
  });

  it('two writers racing on one chain both land, in order', async () => {
    const o = await rk.org();
    const [x, y] = await Promise.all([sweep(o.orgId, 'scans', 1), sweep(o.orgId, 'scans', 2)]);
    expect([x.seq, y.seq].sort()).toEqual([1, 2]);
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true]);
  });

  it('stores counts and a digest, never a pass id or content', async () => {
    const o = await rk.org();
    const r = await writeReceipt(ctx(), {
      orgId: o.orgId,
      cls: 'erasure',
      kind: 'erasure',
      deleted: 3,
      refsDigest: 'a'.repeat(64),
      requestId: 'req-1',
    });
    const row = await first<Record<string, unknown>>(
      rk.kit.env.DB,
      'SELECT * FROM retention_receipts WHERE id = ?',
      [r.id],
    );
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'anonymised',
        'class',
        'cutoff_at',
        'deleted',
        'id',
        'kind',
        'mac',
        'org_id',
        'policy_days',
        'prev_mac',
        'ran_at',
        'refs_digest',
        'request_id',
        'seq',
      ].sort(),
    );
  });
});

const anchorOf = async (r: Receipt): Promise<Anchor> => {
  const base = { orgId: r.orgId, cls: r.cls, seq: r.seq, mac: r.mac, ranAt: r.ranAt };
  return { ...base, anchorMac: await anchorMac(ctx().env, base) };
};

describe('tamper detection', () => {
  const chain = async (): Promise<Receipt[]> => {
    const o = await rk.org();
    for (const n of [1, 2, 3, 4]) await sweep(o.orgId, 'scans', n);
    return (await readReceipts(ctx(), o.orgId, 'scans')).map((r) => r.receipt);
  };
  const marks = async (rows: Receipt[], anchor = null as Anchor | null) =>
    (await verifyChain(ctx().env, rows, anchor)).map((r) => r.verified);

  it('a changed column fails that receipt, and the next one still links to its stored MAC', async () => {
    const rows = await chain();
    for (const edit of [
      { deleted: 99 },
      { cutoffAt: 2 },
      { policyDays: 1 },
      { ranAt: 5 },
      { cls: 'events' },
      { orgId: 'other' },
      { refsDigest: 'x' },
    ])
      expect(await marks(rows.map((r) => (r.seq === 2 ? { ...r, ...edit } : r)))).toEqual([
        true,
        false,
        true,
        true,
      ]);
  });

  it('a changed MAC fails that receipt and the next link', async () => {
    const rows = await chain();
    const bad = rows.map((r) => (r.seq === 2 ? { ...r, mac: '0'.repeat(64) } : r));
    expect(await marks(bad)).toEqual([true, false, false, true]);
    expect(await marks(rows.map((r) => (r.seq === 2 ? { ...r, mac: 'zz' } : r)))).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it('a dropped middle receipt fails every receipt after the gap', async () => {
    const rows = await chain();
    expect(await marks(rows.filter((r) => r.seq !== 2))).toEqual([true, false, true]);
  });

  it('a dropped first receipt fails the chain unless an anchor covers it', async () => {
    const rows = await chain();
    expect(await marks(rows.slice(1))).toEqual([false, true, true]);
    const first = rows[0] as Receipt;
    const a = await anchorOf(first);
    expect(await marks(rows.slice(1), a)).toEqual([true, true, true]);
  });

  it('an anchor that was not MACed under the key, or was edited, fails every receipt', async () => {
    const rows = await chain();
    const first = rows[0] as Receipt;
    const a = await anchorOf(first);
    for (const bad of [
      { ...a, anchorMac: '0'.repeat(64) },
      { ...a, anchorMac: 'nope' },
      { ...a, ranAt: a.ranAt + 1 },
      { ...a, seq: 0 },
      { ...a, cls: 'events' },
    ])
      expect(await marks(rows.slice(1), bad)).toEqual([false, false, false]);
  });

  it('a chain below the head kept outside D1 fails; so does a missing or different head object', async () => {
    const o = await rk.org();
    for (const n of [1, 2, 3]) await sweep(o.orgId, 'scans', n);
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true, true]);
    const bucket = rk.kit.env.BUCKET;
    const key = (seq: number) =>
      `retention/receipts/${o.orgId}/scans/${String(seq).padStart(12, '0')}.json`;
    // The newest receipt was dropped from D1: R2 still holds seq 3, D1 stops at 2 (simulated by an extra head).
    await bucket.put(key(4), JSON.stringify({ seq: 4, mac: 'a'.repeat(64) }));
    expect(await verdicts(o.orgId, 'scans')).toEqual([false, false, false]);
    await bucket.delete(key(4));
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true, true]);
    await bucket.put(key(3), JSON.stringify({ seq: 3, mac: 'b'.repeat(64) }));
    expect(await verdicts(o.orgId, 'scans')).toEqual([false, false, false]);
    // A head whose put failed (no object at or after D1's newest) is re-put on read and verifies again.
    await bucket.delete(key(3));
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true, true]);
  });

  it('a whole chain dropped from D1 is caught by its head objects', async () => {
    expect(await headMatches(ctx(), 'gone-org', 'scans', null)).toBe(true);
    await rk.kit.env.BUCKET.put(
      'retention/receipts/gone-org/scans/000000000001.json',
      JSON.stringify({ seq: 1, mac: 'c'.repeat(64) }),
    );
    expect(await headMatches(ctx(), 'gone-org', 'scans', null)).toBe(false);
  });

  it('reordered receipts keep their own seq and still verify in seq order; a rewritten seq fails', async () => {
    const rows = await chain();
    expect(await marks([...rows].reverse())).toEqual([true, true, true, true]);
    expect(await marks(rows.map((r) => (r.seq === 3 ? { ...r, seq: 4 } : r)))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('a receipt MACed under another key fails', async () => {
    const rows = await chain();
    const other = await makeEnv({ KEK_V1: 'MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=' });
    expect((await verifyChain(other, rows, null)).map((r) => r.verified)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('the table refuses an update and an early delete', async () => {
    const o = await rk.org();
    const r = await sweep(o.orgId, 'scans', 1);
    await expect(
      run(rk.kit.env.DB, 'UPDATE retention_receipts SET deleted = 0 WHERE id = ?', [r.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(rk.kit.env.DB, 'DELETE FROM retention_receipts WHERE id = ?', [r.id]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('6-year sweep', () => {
  const rowsOf = (orgId: string, cls: string) =>
    all<{ seq: number }>(
      rk.kit.env.DB,
      'SELECT seq FROM retention_receipts WHERE org_id = ? AND class = ? ORDER BY seq',
      [orgId, cls],
    );

  it('removes receipts past six years behind an anchor and the chain still verifies', async () => {
    const o = await rk.org();
    const now = ctx().clock.now();
    for (const years of [9, 8, 7])
      await writeReceipt(at(now - years * YEAR), {
        orgId: o.orgId,
        cls: 'scans',
        kind: 'sweep',
        deleted: 1,
      });
    for (const days of [30, 0])
      await writeReceipt(at(now - days * 86_400_000), {
        orgId: o.orgId,
        cls: 'scans',
        kind: 'sweep',
        deleted: 2,
      });
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true, true, true, true]);

    await dailyReceipts(ctx());
    expect((await rowsOf(o.orgId, 'scans')).map((r) => r.seq)).toEqual([4, 5]);
    const anchor = await first<{ seq: number }>(
      rk.kit.env.DB,
      'SELECT seq FROM retention_receipt_anchors WHERE org_id = ? AND class = ?',
      [o.orgId, 'scans'],
    );
    expect(anchor?.seq).toBe(3);
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true]);

    // The chain keeps growing from its head.
    expect((await sweep(o.orgId, 'scans', 1)).seq).toBe(6);
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true, true]);
  });

  it('never removes the newest receipt of a chain, however old', async () => {
    const o = await rk.org();
    const now = ctx().clock.now();
    for (const years of [9, 8])
      await writeReceipt(at(now - years * YEAR), {
        orgId: o.orgId,
        cls: 'scans',
        kind: 'sweep',
        deleted: 1,
      });
    await dailyReceipts(ctx());
    expect((await rowsOf(o.orgId, 'scans')).map((r) => r.seq)).toEqual([2]);
    expect((await sweep(o.orgId, 'scans', 1)).seq).toBe(3);
    expect(await verdicts(o.orgId, 'scans')).toEqual([true, true]);
  });

  it('the anchor only moves forward and is never deleted while receipts remain', async () => {
    const o = await rk.org();
    const now = ctx().clock.now();
    for (const years of [9, 8, 7])
      await writeReceipt(at(now - years * YEAR), {
        orgId: o.orgId,
        cls: 'scans',
        kind: 'sweep',
        deleted: 1,
      });
    await sweep(o.orgId, 'scans', 1);
    await dailyReceipts(ctx());
    const db = rk.kit.env.DB;
    await expect(
      run(db, 'UPDATE retention_receipt_anchors SET seq = 1 WHERE org_id = ?', [o.orgId]),
    ).rejects.toThrow(/forward/);
    await expect(
      run(db, 'DELETE FROM retention_receipt_anchors WHERE org_id = ?', [o.orgId]),
    ).rejects.toThrow(/permanent/);
    // A stale anchor (lower seq) written through the trim changes nothing.
    const { trimChain } = await import('./repo-receipts.ts');
    const stale = { orgId: o.orgId, cls: 'scans', seq: 1, mac: 'x', ranAt: 1, anchorMac: 'y' };
    await trimChain(db, stale);
    const row = await first<{ seq: number }>(
      db,
      'SELECT seq FROM retention_receipt_anchors WHERE org_id = ?',
      [o.orgId],
    );
    expect(row?.seq).toBe(3);
    expect(await verdicts(o.orgId, 'scans')).toEqual([true]);
  });

  it('leaves receipts under six years alone', async () => {
    const o = await rk.org();
    const now = ctx().clock.now();
    for (const years of [5, 4, 1])
      await writeReceipt(at(now - years * YEAR), {
        orgId: o.orgId,
        cls: 'scans',
        kind: 'sweep',
        deleted: 1,
      });
    await dailyReceipts(ctx());
    expect(await rowsOf(o.orgId, 'scans')).toHaveLength(3);
  });

  it('the table refuses to delete an old receipt that has no anchor', async () => {
    const o = await rk.org();
    const now = ctx().clock.now();
    const old = await writeReceipt(at(now - 9 * YEAR), {
      orgId: o.orgId,
      cls: 'scans',
      kind: 'sweep',
      deleted: 1,
    });
    await sweep(o.orgId, 'scans', 1);
    await expect(
      run(rk.kit.env.DB, 'DELETE FROM retention_receipts WHERE id = ?', [old.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('reports the newest receipt per class for the summary', async () => {
    const o = await rk.org();
    await sweep(o.orgId, 'scans', 1);
    await sweep(o.orgId, 'scans', 4);
    await sweep(o.orgId, 'events', 2);
    expect(await lastReceiptRows(rk.kit.env.DB, o.orgId)).toEqual([
      { cls: 'events', ranAt: ctx().clock.now(), deleted: 2 },
      { cls: 'scans', ranAt: ctx().clock.now(), deleted: 4 },
    ]);
  });
});

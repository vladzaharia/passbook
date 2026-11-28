import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all } from '../../platform/db.ts';
import { accessTemplate, gateRow } from './access-test-fixtures.ts';
import { kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { inNow, placeRow, scanAt, trackedZone, zoneDoor } from './occupancy-scan-test-fixtures.ts';
import { RACE_PRESENCE_WRITE } from './race-tags.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

/** The commit batch of a scan at a tracked zone writes the in/out row. */
const COMMIT = RACE_PRESENCE_WRITE;

/** `first` reads and plans, then `second` runs whole and commits, then `first` commits. */
async function interleave(
  first: () => Promise<ScanOutcome>,
  second: () => Promise<ScanOutcome>,
): Promise<[ScanOutcome, ScanOutcome]> {
  const seen: { second?: ScanOutcome } = {};
  const { result, fired } = await beforeBatch(
    kit.env,
    COMMIT,
    async () => {
      seen.second = await second();
    },
    first,
  );
  expect(fired).toBe(true);
  if (!seen.second) throw new Error('second scan did not run');
  return [result, seen.second];
}

describe('occupancy races through the scan path (SA §20.15)', () => {
  it('two doors at a zone that requires tap out: one entry, one Already in, one visit', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const a = await zoneDoor(tpl, [gym]);
    const b = await zoneDoor(tpl, [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const [late, early] = await interleave(
      () => scanAt(a, pass),
      () => scanAt(b, pass),
    );
    expect(early).toMatchObject({ kind: 'ok', occupancy: { state: 'in' } });
    expect(late).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'in', last_scan_id: early.scanId });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1, last_scan_id: early.scanId });
  });

  it('enter versus exit, either order, never leaves a double state', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const way = await zoneDoor(tpl, [gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    // Exit planned while out, the entry commits first: the exit still closes the row it now finds.
    const one = await kit.scanPass(tpl, { plan: 'gold' });
    const [left, entered] = await interleave(
      () => scanAt(exit, one),
      () => scanAt(way, one),
    );
    expect([entered.kind, left.kind]).toEqual(['ok', 'ok']);
    expect(await placeRow(one.id, gym)).toMatchObject({ state: 'out', last_scan_id: left.scanId });
    // Entry planned while out, an exit with nothing to close runs first: the entry still wins.
    kit.clock.advance(5 * MINUTE);
    const two = await kit.scanPass(tpl, { plan: 'gold' });
    const [inside, nothing] = await interleave(
      () => scanAt(way, two),
      () => scanAt(exit, two),
    );
    expect(nothing).toMatchObject({ kind: 'heads_up', reason: 'not_inside' });
    expect(inside.kind).toBe('ok');
    expect(await placeRow(two.id, gym)).toMatchObject({ state: 'in', last_scan_id: inside.scanId });
  });

  it('ten passes at the last five of 25 places: exactly 25 inside', async () => {
    const tpl = await accessTemplate();
    const pool = await trackedZone({ occupancy: 'track', capacity: 25 });
    const a = await zoneDoor(tpl, [pool]);
    const b = await zoneDoor(tpl, [pool]);
    for (let i = 0; i < 20; i++)
      expect((await scanAt(a, await kit.scanPass(tpl, { plan: 'gold' }))).kind).toBe('ok');
    const late = await Promise.all(
      Array.from({ length: 10 }, async () => kit.scanPass(tpl, { plan: 'gold' })),
    );
    const results = await Promise.all(late.map((p, i) => scanAt(i % 2 ? a : b, p)));
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(5);
    const full = results.filter((r) => r.kind !== 'ok');
    expect(full).toHaveLength(5);
    for (const r of full) expect(r).toMatchObject({ kind: 'heads_up', reason: 'capacity_full' });
    expect(await inNow(pool)).toBe(25);
    // Every loser was named by the batch (there is no pre-check): its row says so.
    const named = await all<{ reason: string }>(
      kit.env.DB,
      `SELECT reason FROM scans WHERE id IN (${full.map(() => '?').join(', ')})`,
      full.map((r) => String(r.scanId)),
    );
    expect(named.map((r) => r.reason)).toEqual(Array(5).fill('capacity_full'));
  });

  it('a parent exit and a child entry end consistent in either order', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const pool = await trackedZone({ occupancy: 'track', parentId: gym });
    const gymIn = await zoneDoor(tpl, [gym]);
    const gymOut = await zoneDoor(tpl, [gym], 'out');
    const poolIn = await zoneDoor(tpl, [pool]);

    // The pool entry is planned inside the gym, then the gym exit commits: the entry is not inside.
    const one = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(gymIn, one);
    kit.clock.advance(5 * MINUTE);
    const [entry, left] = await interleave(
      () => scanAt(poolIn, one),
      () => scanAt(gymOut, one),
    );
    expect(left.kind).toBe('ok');
    expect(entry).toMatchObject({ kind: 'heads_up', reason: 'not_inside' });
    expect(await placeRow(one.id, gym)).toMatchObject({ state: 'out' });
    expect(await placeRow(one.id, pool)).toBeNull();

    // The gym exit is planned, then the pool entry commits: the exit takes the pool with it.
    const two = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(gymIn, two);
    kit.clock.advance(5 * MINUTE);
    const [out, inPool] = await interleave(
      () => scanAt(gymOut, two),
      () => scanAt(poolIn, two),
    );
    expect([inPool.kind, out.kind]).toEqual(['ok', 'ok']);
    expect(await placeRow(two.id, gym)).toMatchObject({ state: 'out' });
    expect(await placeRow(two.id, pool)).toMatchObject({ state: 'out' });
  });
});

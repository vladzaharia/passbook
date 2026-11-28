import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { ACCESS, accessTemplate, gateRow } from './access-test-fixtures.ts';
import { HOUR, kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import {
  placeRow,
  scanAt,
  trackedZone,
  undoScan,
  zoneDoor,
} from './occupancy-scan-test-fixtures.ts';
import { RACE_PRESENCE_WRITE } from './race-tags.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

/** `first` reads and plans, then `second` runs whole and commits, then `first` commits. */
async function interleave(
  first: () => Promise<ScanOutcome>,
  second: () => Promise<ScanOutcome>,
): Promise<[ScanOutcome, ScanOutcome]> {
  const seen: { second?: ScanOutcome } = {};
  const { result, fired } = await beforeBatch(
    kit.env,
    RACE_PRESENCE_WRITE,
    async () => {
      seen.second = await second();
    },
    first,
  );
  expect(fired).toBe(true);
  if (!seen.second) throw new Error('second scan did not run');
  return [result, seen.second];
}

describe('occupancy undo through the scan path', () => {
  it('undoes a later visit: the count and the visit start go back, and the row is out again', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone();
    const way = await zoneDoor(tpl, [gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(way, pass);
    kit.clock.advance(10 * MINUTE);
    await scanAt(exit, pass);
    kit.clock.advance(3 * HOUR);
    const again = await scanAt(way, pass);
    expect(again.access?.visits?.used).toBe(2);
    expect((await undoScan(way, again.scanId)).status).toBe(200);
    expect(await gateRow(pass.id)).toMatchObject({ count: 1, visit_at: TEST_NOW });
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'out' });
  });

  it('undoes a repeat that left the zones below: the child is in again', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'track' });
    const pool = await trackedZone({ occupancy: 'track', parentId: gym });
    const gymIn = await zoneDoor(tpl, [gym]);
    const poolIn = await zoneDoor(tpl, [pool]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(poolIn, pass);
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'in', entered_at: TEST_NOW });
    kit.clock.advance(5 * MINUTE);
    const repeat = await scanAt(gymIn, pass);
    expect(repeat.kind).toBe('ok');
    expect(await placeRow(pass.id, pool)).toMatchObject({ state: 'out' });
    expect((await undoScan(gymIn, repeat.scanId)).status).toBe(200);
    expect(await placeRow(pass.id, pool)).toMatchObject({ state: 'in', entered_at: TEST_NOW });
    expect(await placeRow(pass.id, gym)).toMatchObject({ state: 'in', entered_at: TEST_NOW });
  });

  it('undoes an entry with an implied parent: both rows go', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'track' });
    const pool = await trackedZone({ occupancy: 'track', parentId: gym });
    const poolIn = await zoneDoor(tpl, [pool]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const entry = await scanAt(poolIn, pass);
    expect((await undoScan(poolIn, entry.scanId)).status).toBe(200);
    expect(await placeRow(pass.id, pool)).toBeNull();
    expect(await placeRow(pass.id, gym)).toBeNull();
  });
});

describe('occupancy: the wait and the guest limit named by the batch', () => {
  it('a racing second door inside the wait is held as cooldown', async () => {
    const tpl = await accessTemplate({
      ...ACCESS,
      rules: { visitGapMinutes: 120, reentryMinutes: 10 },
    });
    const gym = await trackedZone({ occupancy: 'track' });
    const a = await zoneDoor(tpl, [gym]);
    const b = await zoneDoor(tpl, [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const [late, early] = await interleave(
      () => scanAt(a, pass),
      () => scanAt(b, pass),
    );
    expect(early.kind).toBe('ok');
    expect(late).toMatchObject({ kind: 'heads_up', reason: 'cooldown' });
    expect(await placeRow(pass.id, gym)).toMatchObject({ last_scan_id: early.scanId });
  });

  it('a racing second door past a guest limit is refused as guest_visits_used', async () => {
    const tpl = await accessTemplate({ ...ACCESS, rules: { visitGapMinutes: 0 } });
    const gym = await trackedZone({ occupancy: 'track' });
    const a = await zoneDoor(tpl, [gym]);
    const b = await zoneDoor(tpl, [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 1 });
    const [late, early] = await interleave(
      () => scanAt(a, pass),
      () => scanAt(b, pass),
    );
    expect(early.kind).toBe('ok');
    expect(late).toMatchObject({ kind: 'refused', reason: 'guest_visits_used' });
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
  });
});

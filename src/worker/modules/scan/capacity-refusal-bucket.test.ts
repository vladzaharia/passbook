import { beforeAll, describe, expect, it } from 'vitest';
import { accessTemplate } from './access-test-fixtures.ts';
import { kit, setupActionFixture } from './act-test-fixtures.ts';
import { scanAt, trackedZone } from './occupancy-scan-test-fixtures.ts';
import { bucketOutcome } from './outcome-bucket.ts';
import { doorAndMonitor } from './overrides-test-fixtures.ts';

beforeAll(setupActionFixture);

describe('a full place counts as Refused', () => {
  it('buckets by reason', () => {
    expect(bucketOutcome('heads_up', 'capacity_full')).toBe('refused');
    expect(bucketOutcome('heads_up', 'already_done')).toBe('heads_up');
    expect(bucketOutcome('ok', null)).toBe('ok');
  });

  it('shows in the scanner summary and recent scans, not under Heads-up', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce', capacity: 1 });
    const rig = await doorAndMonitor(tpl, [gym]);
    await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
    const held = await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'capacity_full' });
    const summary = (await (await kit.get(rig.door.headers, '/summary')).json()) as {
      ok: number;
      headsUp: number;
      refused: number;
    };
    expect(summary).toMatchObject({ ok: 1, headsUp: 0, refused: 1 });
    const recent = (await (await kit.get(rig.door.headers, '/scans')).json()) as {
      items: { scanId: string; outcome: string }[];
    };
    expect(recent.items.find((i) => i.scanId === held.scanId)?.outcome).toBe('refused');
  });
});

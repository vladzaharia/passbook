import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { flag } from '../../../shared/contracts/entitlements/kinds.ts';
import { ENTITLEMENT_KEYS, ENTITLEMENTS } from '../../../shared/contracts/entitlements.ts';
import { run } from '../../platform/db.ts';
import { liveNeeds } from './live-features.ts';
import {
  admin,
  consoleCall,
  create,
  env,
  orgId,
  setupScannerFixture,
} from './scanners-split-test-fixtures.ts';

// Go live leaves the Test waiver (billing AD5). The door keys arrive with E5, E6 and E15, so the test
// registers `scanning.approvals` itself, as E6 will.
const registry = ENTITLEMENTS as Record<string, unknown>;
beforeAll(() => {
  registry['scanning.approvals'] = flag([0, 0, 1, 1, 1, 0]);
  (ENTITLEMENT_KEYS as string[]).push('scanning.approvals');
});
afterAll(() => {
  delete registry['scanning.approvals'];
  (ENTITLEMENT_KEYS as string[]).pop();
});

describe('liveNeeds', () => {
  it('names the waived keys a scanner uses, by role and settings', () => {
    expect(liveNeeds('scan', { flow: 'auto' })).toEqual([]);
    expect(liveNeeds('kiosk', {})).toEqual([{ key: 'scanning.selfCheckIn' }]);
    expect(liveNeeds('kiosk', { walkIn: { templateId: 't' } })).toEqual([
      { key: 'scanning.selfCheckIn' },
      { key: 'scanning.kioskWalkIn' },
    ]);
    expect(liveNeeds('kiosk', { entries: { walkIn: true } })).toContainEqual({
      key: 'scanning.kioskWalkIn',
    });
    expect(liveNeeds('customer', null)).toEqual([{ key: 'scanning.display' }]);
    expect(liveNeeds('monitor', {})).toEqual([{ key: 'scanning.desk' }]);
    expect(liveNeeds('scan', { direction: 'both', approvals: 'desk', deskActions: true })).toEqual([
      { key: 'scanning.desk' },
      { key: 'scanning.rules', want: 'inout' },
      { key: 'scanning.approvals' },
    ]);
    expect(liveNeeds('scan', { direction: 'out', hardLimit: true })).toEqual([
      { key: 'scanning.rules', want: 'capacity' },
    ]);
  });
});

setupScannerFixture();

const plan = async (value: string | null) => {
  await run(
    env.DB,
    `INSERT OR REPLACE INTO entitlement_presets (preset, key, value)
     SELECT preset, 'scanning.approvals', '0' FROM org_entitlements WHERE org_id = ?`,
    [orgId],
  );
  if (value !== null)
    await run(
      env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'scanning.approvals', ?, 1)`,
      [orgId, value],
    );
};

const testScanner = async () => {
  const { body } = await create({ name: 'Request desk' }, admin('test'));
  await run(
    env.DB,
    `UPDATE scanners SET settings = json_set(settings, '$.approvals', 'desk') WHERE id = ?`,
    [body.id],
  );
  return body.id;
};

const goLive = (id: string) => consoleCall('POST', `/${id}/mode`, { mode: 'live' }, admin('test'));

describe('Go live re-checks the waived features in Live', () => {
  it('refuses a Test scanner whose feature the Live plan lacks, naming it', async () => {
    await plan(null);
    const id = await testScanner();
    const res = await goLive(id);
    await expectProblem(res, 403, 'FEATURE_NOT_INCLUDED');
    expect(((await res.json()) as { feature?: string }).feature).toBe('scanning.approvals');
    const row = await env.DB.prepare('SELECT mode FROM scanners WHERE id = ?').bind(id).first();
    expect(row?.mode).toBe('test');
  });

  it('moves it when the Live plan has the feature', async () => {
    await plan('1');
    const id = await testScanner();
    expect((await goLive(id)).status).toBe(200);
  });

  it('never checks a move to Test', async () => {
    await plan('1');
    const id = await testScanner();
    expect((await goLive(id)).status).toBe(200);
    await plan('0');
    expect((await consoleCall('POST', `/${id}/mode`, { mode: 'test' })).status).toBe(200);
  });
});

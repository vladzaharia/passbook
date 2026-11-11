import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeOrg,
  makePass,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import type { ScanSeed } from './repo-staff-admin-test-fixtures.ts';
import { setupStaffAdminTestKit, WireStaffSchema } from './staff-admin-test-fixtures.ts';

const staffAdmin = setupStaffAdminTestKit();
const { admin, itemPath, list, seedScan, send } = staffAdmin;
let env: typeof staffAdmin.env;
let f: typeof staffAdmin.f;
let clock: typeof staffAdmin.clock;
let orgId: typeof staffAdmin.orgId;
beforeEach(() => {
  ({ env, f, clock, orgId } = staffAdmin);
});

describe('mode-specific staff activity and device PIN locks', () => {
  it('counts completed successful, non-undone activity in each scanner timezone and mode', async () => {
    const person = await makeScanStaff(f, { orgId, name: 'Alice' });
    const idle = await makeScanStaff(f, { orgId, name: 'Idle' });
    const other = await makeOrg(f);
    const utc = await makeScanner(f, { orgId });
    const la = await makeScanner(f, { orgId });
    const test = await makeScanner(f, { orgId, mode: 'test' });
    const foreign = await makeScanner(f, { orgId: other.id });
    await run(env.DB, "UPDATE scanners SET name = 'UTC door' WHERE id = ?", [utc.id]);
    await run(
      env.DB,
      "UPDATE scanners SET name = 'West door', time_zone = 'America/Los_Angeles' WHERE id = ?",
      [la.id],
    );
    await run(env.DB, "UPDATE scanners SET name = 'Test door' WHERE id = ?", [test.id]);
    const add = (scannerId: string, at: number, more: Partial<ScanSeed> = {}) =>
      seedScan({ staffId: person.id, scannerId, at, ...more });
    const now = clock.now();
    await add(utc.id, Date.UTC(2026, 5, 1, 10));
    await add(la.id, Date.UTC(2026, 5, 1, 8));
    await add(la.id, Date.UTC(2026, 5, 1, 6)); // still the previous day in Los Angeles
    await add(utc.id, Date.UTC(2026, 4, 31, 23, 59));
    await add(utc.id, now - 30 * 60_000, { undoneAt: now });
    await add(utc.id, now - 20 * 60_000, { actionKind: 'undo' });
    await add(utc.id, now - 15 * 60_000, { undoneBy: 'missing-undo' });
    await add(utc.id, now - 10 * 60_000, { outcome: 'refused', actionKind: null });
    await add(utc.id, now - 60_000, { state: 'pending', outcome: null, actionKind: null });
    await add(utc.id, now - 45_000, { state: 'pending', outcome: 'ok' });
    await add(test.id, now - 2 * 60 * 60_000, { mode: 'test' });
    await add(test.id, now - 5 * 60_000, { mode: 'test' });
    await add(foreign.id, now - 30_000, { org: other.id });
    const live = await list();
    const sandbox = await list(orgId, 'test');
    expect(live.find((staff) => staff.id === person.id)).toMatchObject({
      today: 2,
      lastScan: { at: now - 10 * 60_000, scannerName: 'Scanner' },
    });
    expect(sandbox.find((staff) => staff.id === person.id)).toMatchObject({
      today: 2,
      lastScan: { at: now - 5 * 60_000, scannerName: 'Scanner' },
    });
    const liveUpdate = await send('PATCH', itemPath(person.id), { role: 'desk' });
    const testUpdate = await send('PATCH', itemPath(person.id), { role: 'manager' }, admin('test'));
    expect(liveUpdate.status).toBe(200);
    expect(testUpdate.status).toBe(200);
    expect(WireStaffSchema.parse(await liveUpdate.json())).toMatchObject({
      today: 2,
      lastScan: { at: now - 10 * 60_000, scannerName: 'Scanner' },
    });
    expect(WireStaffSchema.parse(await testUpdate.json())).toMatchObject({
      today: 2,
      lastScan: { at: now - 5 * 60_000, scannerName: 'Scanner' },
    });
    for (const rows of [live, sandbox]) {
      expect(rows.find((staff) => staff.id === idle.id)).toMatchObject({
        today: 0,
        lastScan: null,
      });
    }
  });

  it('keeps activity for a removed scanner, using UTC and a neutral scanner label', async () => {
    const person = await makeScanStaff(f, { orgId });
    await seedScan({ staffId: person.id, scannerId: 'removed-scanner', at: clock.now() - 1000 });
    expect((await list())[0]).toMatchObject({
      id: person.id,
      today: 1,
      lastScan: { at: clock.now() - 1000, scannerName: 'Scanner' },
    });
  });

  it('excludes foreign and quarantined scan relationships before activity totals and latest selection', async () => {
    const person = await makeScanStaff(f, { orgId });
    const other = await makeOrg(f);
    const foreignStaff = await makeScanStaff(f, { orgId: other.id });
    const local = await makeScanner(f, { orgId });
    const foreign = await makeScanner(f, { orgId: other.id });
    const testScanner = await makeScanner(f, { orgId, mode: 'test' });
    const foreignEvent = await makeScanEvent(f, { orgId: other.id });
    const testEvent = await makeScanEvent(f, { orgId, mode: 'test' });
    const localTemplate = makeTemplate({ id: f.ids.id(), orgId });
    const foreignTemplate = makeTemplate({ id: f.ids.id(), orgId: other.id });
    await persistTemplate(f, foreignTemplate.resolved, { registry: foreignTemplate.registry });
    await persistTemplate(f, localTemplate.resolved, { registry: localTemplate.registry });
    const testRelease = await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: localTemplate.registry },
      {
        orgId,
        mode: 'test',
        templateId: localTemplate.resolved.id,
        version: localTemplate.resolved.version,
      },
    );
    const quarantined = await makePass(f, { orgId, template: localTemplate.resolved });
    const foreignPass = await makePass(f, { orgId: other.id, template: localTemplate.resolved });
    const wrongMode = await makePass(f, { orgId, mode: 'test', template: localTemplate.resolved });
    const badPin = await makePass(f, { orgId, template: localTemplate.resolved });
    const missingWallet = await makePass(f, { orgId, template: localTemplate.resolved });
    const removed = await makePass(f, { orgId, template: localTemplate.resolved });
    const hardDeleted = await makePass(f, { orgId, template: localTemplate.resolved });
    const formerlyQuarantined = await makePass(f, { orgId, template: localTemplate.resolved });
    await run(env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [quarantined.id]);
    await run(env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [clock.now(), removed.id]);
    await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [testRelease.id, badPin.id]);

    const now = clock.now();
    await seedScan({ staffId: person.id, scannerId: local.id, at: now - 60_000 });
    for (const [pass, at] of [
      [missingWallet, now - 40_000],
      [removed, now - 30_000],
    ] as const) {
      const id = await seedScan({ staffId: person.id, scannerId: local.id, at });
      await run(env.DB, 'UPDATE scans SET pass_id = ?, template_id = ? WHERE id = ?', [
        pass.id,
        localTemplate.resolved.id,
        id,
      ]);
    }
    // Missing actors are historical, not cross-tenant references.
    await seedScan({ staffId: person.id, scannerId: 'deleted-scanner', at: now - 20_000 });
    await seedScan({
      staffId: person.id,
      scannerId: local.id,
      at: now - 15_000,
      passless: true,
      outcome: 'refused',
      reason: 'not_found',
      actionKind: null,
    });
    await seedScan({ staffId: person.id, scannerId: local.id, at: now - 2_000, passless: true });
    await seedScan({
      staffId: person.id,
      scannerId: local.id,
      at: now - 2_000,
      passless: true,
      outcome: 'refused',
      reason: 'ambiguous',
      actionKind: null,
    });
    const deletedScan = await seedScan({
      staffId: person.id,
      scannerId: local.id,
      at: now - 2_000,
    });
    await run(env.DB, 'UPDATE scans SET pass_id = ?, template_id = ? WHERE id = ?', [
      hardDeleted.id,
      localTemplate.resolved.id,
      deletedScan,
    ]);
    await run(env.DB, 'DELETE FROM passes WHERE id = ?', [hardDeleted.id]);
    const legacyScan = await seedScan({ staffId: person.id, scannerId: local.id, at: now - 2_000 });
    await run(env.DB, 'UPDATE scans SET pass_id = ?, template_id = ? WHERE id = ?', [
      formerlyQuarantined.id,
      localTemplate.resolved.id,
      legacyScan,
    ]);
    await run(env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      formerlyQuarantined.id,
    ]);
    await run(env.DB, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [
      formerlyQuarantined.id,
    ]);
    const invalid: Array<[string, string]> = [
      ['scanner_id', foreign.id],
      ['scanner_id', testScanner.id],
      ['actor_id', foreign.id],
      ['actor_id', testScanner.id],
      ['event_id', foreignEvent.id],
      ['event_id', testEvent.id],
      ['approved_by', foreignStaff.id],
      ['template_id', foreignTemplate.resolved.id],
      ['pass_id', quarantined.id],
      ['pass_id', foreignPass.id],
      ['pass_id', wrongMode.id],
      ['pass_id', badPin.id],
    ];
    for (const [column, value] of invalid) {
      const id = await seedScan({ staffId: person.id, scannerId: local.id, at: now - 1_000 });
      await run(env.DB, `UPDATE scans SET ${column} = ? WHERE id = ?`, [value, id]);
    }

    expect((await list()).find((staff) => staff.id === person.id)).toMatchObject({
      today: 4,
      lastScan: { at: now - 20_000, scannerName: 'Scanner' },
    });
    expect((await list(orgId, 'test')).find((staff) => staff.id === person.id)).toMatchObject({
      today: 0,
      lastScan: null,
    });
  });
});

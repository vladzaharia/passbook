import { describe, expect, it } from 'vitest';
import {
  makeScanEvent,
  makeScanner,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { ScanEventSchema } from '../../../shared/contracts/index.ts';
import { all, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  call,
  clock,
  env,
  eventId,
  f,
  member,
  orgId,
  otherOrgId,
  page,
  primaryTemplate,
  reader,
  recordedCheckIn,
  templateId,
} from './events-tenant-split-test-fixtures.ts';
import { makeLegacyScanPass } from './test-kit.ts';

describe('scan event tenant routes', () => {
  it('does not expose foreign links or count corrupt, quarantined and wrong-mode pass relations', async () => {
    const foreignTemplate = makeTemplate({ id: f.ids.id(), orgId: otherOrgId });
    await persistTemplate(f, foreignTemplate.resolved, { registry: foreignTemplate.registry });
    const foreignRelease = await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: foreignTemplate.registry },
      {
        orgId: otherOrgId,
        templateId: foreignTemplate.resolved.id,
        version: foreignTemplate.resolved.version,
        mode: 'live',
      },
    );
    await makeScanner(f, { orgId: otherOrgId, eventId });
    await makeScanner(f, { orgId, mode: 'test', eventId });
    await makeScanner(f, { orgId, kind: 'display', eventId });
    const revoked = await makeScanner(f, { orgId, eventId, revoked: true });

    const good = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const foreign = await makeLegacyScanPass(f, {
      orgId: otherOrgId,
      template: foreignTemplate.resolved,
    });
    const wrongMode = await makeLegacyScanPass(f, {
      orgId,
      mode: 'test',
      template: primaryTemplate.resolved,
    });
    const quarantined = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const badPin = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const missingWallet = await makeLegacyScanPass(f, {
      orgId,
      template: primaryTemplate.resolved,
    });
    const removed = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const deleted = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const voided = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const expired = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    for (const pass of [
      good,
      quarantined,
      badPin,
      missingWallet,
      removed,
      deleted,
      voided,
      expired,
    ])
      await recordedCheckIn(pass.id);
    // Real, separately scoped check-ins cannot authorize forged links to this event.
    const foreignEvent = await makeScanEvent(f, {
      orgId: otherOrgId,
      templateIds: [foreignTemplate.resolved.id],
    });
    const testEvent = await makeScanEvent(f, { orgId, mode: 'test', templateIds: [templateId] });
    const foreignScanner = await makeScanner(f, { orgId: otherOrgId, eventId: foreignEvent.id });
    const testScanner = await makeScanner(f, { orgId, mode: 'test', eventId: testEvent.id });
    const foreignScan = await recordedCheckIn(foreign.id, foreignScanner);
    const testScan = await recordedCheckIn(wrongMode.id, testScanner);
    const forgedArrival = async (passId: string, relatedTemplateId: string, scanId: string) => {
      await run(
        env.DB,
        `INSERT INTO scan_gates
        (pass_id,action_id,scope,org_id,mode,template_id,kind,state,count,first_at,last_at,last_scan_id)
        VALUES (?,'check_in',?,?,'live',?,'check_in','in',1,?,?,?)`,
        [passId, `event:${eventId}`, orgId, relatedTemplateId, clock.now(), clock.now(), scanId],
      );
    };
    await forgedArrival(foreign.id, foreignTemplate.resolved.id, foreignScan);
    await forgedArrival(wrongMode.id, templateId, testScan);
    await run(env.DB, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
      eventId,
      foreignTemplate.resolved.id,
    ]);
    await run(env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [quarantined.id]);
    await run(env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [foreignRelease.id, badPin.id]);
    await run(env.DB, 'UPDATE pass_versions SET pass_json=NULL WHERE pass_id=?', [
      missingWallet.id,
    ]);
    await run(env.DB, 'UPDATE passes SET removed_at=? WHERE id=?', [clock.now(), removed.id]);
    await run(env.DB, 'UPDATE passes SET deleted_at=? WHERE id=?', [clock.now(), deleted.id]);
    await run(env.DB, "UPDATE passes SET status='voided' WHERE id=?", [voided.id]);
    await run(
      env.DB,
      `UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate','2020-01-01T00:00:00Z') WHERE pass_id=?`,
      [expired.id],
    );
    const response = await call(reader, 'GET', `/${eventId}`);
    expect(response.status).toBe(200);
    expect(ScanEventSchema.parse(await response.json())).toMatchObject({
      templateIds: [templateId],
      arrived: 6,
      expected: 1,
      scanners: 2,
    });
    const listed = await page(await call(reader, 'GET', `?orgId=${orgId}`));
    expect(listed.items.find((item) => item.id === eventId)).toMatchObject({
      templateIds: [templateId],
      arrived: 6,
      expected: 1,
      scanners: 2,
    });
    expect(
      (await call(member, 'POST', `/${eventId}/scanners`, { scannerIds: [revoked.id] })).status,
    ).toBe(404);
    expect((await call(member, 'PATCH', `/${eventId}`, { templateIds: [templateId] })).status).toBe(
      200,
    );
    expect(
      await all(env.DB, 'SELECT template_id FROM scan_event_templates WHERE event_id=?', [eventId]),
    ).toEqual([{ template_id: templateId }]);
  }, 60_000);

  it('retains historical arrivals without an available current pass policy', async () => {
    const pass = await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    await recordedCheckIn(pass.id);
    // Older witnessed event gates predate the separate event-presence row.
    await run(env.DB, 'DELETE FROM scan_presence WHERE pass_id=? AND scope=?', [
      pass.id,
      `event:${eventId}`,
    ]);
    await run(env.DB, "UPDATE templates SET status='archived' WHERE id=?", [templateId]);
    const response = await call(reader, 'GET', `/${eventId}`);
    expect(response.status).toBe(200);
    expect(ScanEventSchema.parse(await response.json())).toMatchObject({ arrived: 1, expected: 0 });
    const listed = await page(await call(reader, 'GET', `?orgId=${orgId}`));
    expect(listed.items.find((item) => item.id === eventId)).toMatchObject({
      arrived: 1,
      expected: 0,
    });
  });
});

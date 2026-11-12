import { beforeAll, describe, expect, it } from 'vitest';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { scanPasslessCandidateSql } from './repo-scan-passless.ts';
import { sessionCountScopeFixture } from './repo-session-count-scope-test-fixtures.ts';
import { walletIdentityPredicateSql } from './repo-wallet-snapshot.ts';
import { key } from './test-kit.ts';

const scope = sessionCountScopeFixture();
beforeAll(scope.setup);

describe('managed scanning session retained counts', () => {
  it('counts linked and retained successes once, but excludes a proven passless refusal', async () => {
    const { kit, templateId, workspace, checkedIn, hardDelete, expectCounts } = scope;
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const sessionId = await workspace(scanner, event.id);
    const linked = await kit.scanPass(templateId);
    const retained = await kit.scanPass(templateId);
    const linkedId = await checkedIn(scanner, linked);
    const retainedId = await checkedIn(scanner, retained);
    expect(
      await first(
        kit.env.DB,
        `SELECT state,outcome,pass_id,event_id,
          EXISTS (SELECT 1 FROM pass_events e WHERE e.pass_id=s.pass_id
            AND json_extract(e.data,'$.scanId')=s.id) AS has_event,
          EXISTS (SELECT 1 FROM scan_retention_proofs r
            WHERE r.scan_id=s.id AND r.excluded=0 AND r.invalidated=0) AS has_retention
        FROM scans s WHERE s.id=?`,
        [linkedId],
      ),
    ).toEqual({
      state: 'done',
      outcome: 'ok',
      pass_id: linked.id,
      event_id: event.id,
      has_event: 1,
      has_retention: 1,
    });
    await hardDelete(retained);
    expect(await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id=?', [retainedId])).toEqual({
      pass_id: null,
    });
    await expectCounts(sessionId, 2, 1, 1);

    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { code: `NO-MATCH-${key()}`, method: 'camera' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    const outcome = ScanOutcomeSchema.parse(await response.json());
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
    if (!outcome.scanId) throw new Error('Missing refusal scan ID');
    expect(
      await first(
        kit.env.DB,
        `SELECT COUNT(*) AS n FROM scans s WHERE s.id=? AND ${scanPasslessCandidateSql('s')}`,
        [outcome.scanId],
      ),
    ).toEqual({ n: 1 });
    await expectCounts(sessionId, 2, 1, 1);
  });

  it('validates Wallet expiry dates, separator, time and timezone in SQL', async () => {
    const { kit, templateId } = scope;
    const pass = await kit.scanPass(templateId);
    for (const [expiry, valid] of [
      ['2027-02-28T12:34:00Z', 1],
      ['2027-02-28T12:34:00+02:00', 1],
      ['2027-02-30T12:34:00Z', 0],
      ['2027-02-28t12:34:00Z', 0],
      ['2027-02-28T12:xx:00Z', 0],
      ['2027-02-28T12:34:00', 0],
    ] as const) {
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=? AND version=?",
        [expiry, pass.id, pass.version],
      );
      expect(
        await first(
          kit.env.DB,
          `SELECT (${walletIdentityPredicateSql({ passAlias: 'p' })}) AS valid
            FROM passes p WHERE p.id=?`,
          [pass.id],
        ),
      ).toEqual({ valid });
    }
  });

  it('counts intact 0041 retained candidates, but not missing, excluded, invalidated or cross-scope proof', async () => {
    const {
      kit,
      templateId,
      foreignOrgId,
      foreignTemplateId,
      workspace,
      attach,
      record,
      expectCounts,
      checkedIn,
      hardDelete,
      misScopeProof,
    } = scope;
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const sessionId = await workspace(scanner, event.id);
    const second = await kit.scanner({ eventId: event.id });
    await attach(second, sessionId);

    const retained = await kit.scanPass(templateId);
    const retainedId = await checkedIn(scanner, retained);
    expect(
      await first(
        kit.env.DB,
        'SELECT org_id,mode,excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [retainedId],
      ),
    ).toEqual({ org_id: kit.org.id, mode: 'live', excluded: 0, invalidated: 0 });
    await expectCounts(sessionId, 1, 2, 2);
    await hardDelete(retained);
    expect(await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id=?', [retainedId])).toEqual({
      pass_id: null,
    });
    await expectCounts(sessionId, 1, 2, 2);

    await record(scanner.id, null);
    await expectCounts(sessionId, 1, 2, 2);
    const unsigned = await kit.scanPass(templateId);
    const unsignedId = await record(scanner.id, unsigned.id);
    await expectCounts(sessionId, 2, 2, 2);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id=?', [unsigned.id]);
    expect(await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id=?', [unsignedId])).toEqual({
      pass_id: null,
    });
    await expectCounts(sessionId, 1, 2, 2);

    const excluded = await kit.scanPass(templateId);
    const excludedId = await checkedIn(second, excluded);
    await hardDelete(excluded);
    await expectCounts(sessionId, 2, 2, 2);
    await run(kit.env.DB, 'INSERT INTO scan_quarantine_exclusions (scan_id) VALUES (?)', [
      excludedId,
    ]);
    await expectCounts(sessionId, 1, 2, 2);

    const invalidated = await kit.scanPass(templateId);
    const invalidatedId = await checkedIn(second, invalidated);
    await hardDelete(invalidated);
    await expectCounts(sessionId, 2, 2, 2);
    await run(kit.env.DB, 'UPDATE scan_retention_proofs SET invalidated=1 WHERE scan_id=?', [
      invalidatedId,
    ]);
    await expectCounts(sessionId, 1, 2, 2);

    const quarantined = await kit.scanPass(templateId);
    const quarantinedId = await checkedIn(scanner, quarantined);
    await expectCounts(sessionId, 2, 2, 2);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [quarantined.id]);
    expect(
      await first(kit.env.DB, 'SELECT excluded FROM scan_retention_proofs WHERE scan_id=?', [
        quarantinedId,
      ]),
    ).toEqual({ excluded: 1 });
    await expectCounts(sessionId, 1, 2, 2);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=0 WHERE id=?', [quarantined.id]);
    await hardDelete(quarantined);
    await expectCounts(sessionId, 1, 2, 2);

    const foreignEvent = await kit.event({ orgId: foreignOrgId, templateIds: [foreignTemplateId] });
    const foreignScanner = await kit.scanner({ orgId: foreignOrgId, eventId: foreignEvent.id });
    const foreignPass = await kit.scanPass(foreignTemplateId, {}, { orgId: foreignOrgId });
    const foreignId = await checkedIn(foreignScanner, foreignPass);
    await hardDelete(foreignPass);
    await misScopeProof(foreignId, scanner.id);
    expect(
      await first(
        kit.env.DB,
        `SELECT s.org_id AS scan_org,p.org_id AS proof_org,p.mode,p.excluded,p.invalidated
      FROM scans s JOIN scan_retention_proofs p ON p.scan_id=s.id WHERE s.id=?`,
        [foreignId],
      ),
    ).toEqual({
      scan_org: kit.org.id,
      proof_org: foreignOrgId,
      mode: 'live',
      excluded: 0,
      invalidated: 0,
    });
    await expectCounts(sessionId, 1, 2, 2);

    const testEvent = await kit.event({ mode: 'test', templateIds: [templateId] });
    const testScanner = await kit.scanner({ mode: 'test', eventId: testEvent.id });
    const testPass = await kit.scanPass(templateId, {}, { mode: 'test' });
    const testId = await checkedIn(testScanner, testPass);
    await hardDelete(testPass);
    await misScopeProof(testId, scanner.id);
    expect(
      await first(
        kit.env.DB,
        `SELECT s.mode AS scan_mode,p.mode AS proof_mode,p.excluded,p.invalidated
      FROM scans s JOIN scan_retention_proofs p ON p.scan_id=s.id WHERE s.id=?`,
        [testId],
      ),
    ).toEqual({ scan_mode: 'live', proof_mode: 'test', excluded: 0, invalidated: 0 });
    await expectCounts(sessionId, 1, 2, 2);
  });
});

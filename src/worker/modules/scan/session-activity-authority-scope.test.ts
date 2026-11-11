import { describe, expect, it } from 'vitest';
import { makeOrg, runOne } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { run, stmt } from '../../platform/db.ts';
import {
  clearScanRetentionDeleteStmt,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import {
  ACTION,
  ACTIVITY_NAME,
  activityFixture,
  atActivityRead,
  attach,
  consoleRows,
  deviceRows,
  noLeak,
  record,
  workspace,
} from './repo-session-activity-authority-test-fixtures.ts';
import { prepareScanRetentionDelete } from './scan-retention-proof.ts';
import { codeOf, key } from './test-kit.ts';

describe('session activity row scope', () => {
  it('preserves linked, retained and passless rows while excluding invalidated evidence', async () => {
    const f = await activityFixture();
    const retained = await f.kit.scanPass(f.template, { memberName: 'Deleted guest' });
    const retainedId = await record(f.kit, f.scanner, retained);
    const invalid = await f.kit.scanPass(f.template, { memberName: 'Invalidated guest' });
    const invalidId = await record(f.kit, f.scanner, invalid);
    const excluded = await f.kit.scanPass(f.template, { memberName: 'Excluded guest' });
    const excludedId = await record(f.kit, f.scanner, excluded);
    for (const pass of [retained, invalid, excluded]) {
      const prepared = await prepareScanRetentionDelete(f.kit.env, pass);
      const results = await f.kit.env.DB.batch([
        stageScanRetentionDeleteStmt(f.kit.env.DB, pass.id, prepared),
        stmt(f.kit.env.DB, 'DELETE FROM passes WHERE id=? RETURNING id', [pass.id]),
        clearScanRetentionDeleteStmt(f.kit.env.DB, prepared),
      ]);
      expect(results[1]?.results).toEqual([{ id: pass.id }]);
    }
    await run(f.kit.env.DB, 'UPDATE scan_retention_proofs SET invalidated=1 WHERE scan_id=?', [
      invalidId,
    ]);
    await run(f.kit.env.DB, 'INSERT INTO scan_quarantine_exclusions(scan_id) VALUES(?)', [
      excludedId,
    ]);

    const voided = await f.kit.scanPass(f.template, { memberName: 'Voided guest' });
    await run(f.kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [voided.id]);
    f.kit.clock.advance(1);
    const refusedResponse = await f.kit.post(f.scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(voided),
      clientTs: f.kit.clock.now(),
      actionId: ACTION.id,
    });
    expect(refusedResponse.status).toBe(200);
    const refused = ScanOutcomeSchema.parse(await refusedResponse.json());
    expect(refused).toMatchObject({ kind: 'refused', reason: 'voided' });
    if (!refused.scanId) throw new Error('Missing pass-bound refusal');

    const noMatch = async () => {
      f.kit.clock.advance(1);
      const response = await f.kit.post(f.scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: { code: `NO-MATCH-${key()}`, method: 'camera' },
        clientTs: f.kit.clock.now(),
        actionId: ACTION.id,
      });
      expect(response.status).toBe(200);
      const outcome = ScanOutcomeSchema.parse(await response.json());
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found' });
      if (!outcome.scanId) throw new Error('Missing passless refusal');
      return outcome.scanId;
    };
    const passless = await noMatch();

    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())]) {
      expect(rows).toEqual([
        expect.objectContaining({ id: passless, outcome: 'refused', passId: null, title: null }),
        expect.objectContaining({
          id: refused.scanId,
          outcome: 'refused',
          passId: null,
          title: null,
        }),
        expect.objectContaining({ id: retainedId, outcome: 'ok', passId: null, title: null }),
        expect.objectContaining({
          id: f.scanId,
          outcome: 'ok',
          passId: f.pass.id,
          title: ACTIVITY_NAME,
        }),
      ]);
      for (const value of [
        invalidId,
        excludedId,
        retained.id,
        invalid.id,
        excluded.id,
        voided.id,
        'Deleted guest',
        'Invalidated guest',
        'Excluded guest',
        'Voided guest',
      ])
        expect(JSON.stringify(rows)).not.toContain(value);
    }

    const raced = await atActivityRead(f.kit.env, f.console, async (db) => {
      await run(db, 'UPDATE scan_retention_proofs SET invalidated=1 WHERE scan_id=?', [retainedId]);
      await run(db, "UPDATE scans SET reason='needs_approval' WHERE id=?", [passless]);
    });
    const afterRace = await consoleRows(raced);
    expect(afterRace.map(({ id }) => id)).toEqual([refused.scanId, f.scanId]);
    expect(afterRace[1]).toMatchObject({ passId: f.pass.id, title: ACTIVITY_NAME });
  }, 120_000);

  it('filters before applying the 20-row limit and orders equal timestamps by scan ID', async () => {
    const f = await activityFixture();
    const insert = (passId: string | null, templateId: string | null, at: number) => {
      const id = f.kit.fx.ids.id();
      return {
        id,
        statement: stmt(
          f.kit.env.DB,
          `INSERT INTO scans
          (id,org_id,mode,pass_id,template_id,scanner_id,event_id,actor_type,actor_id,actor_key,
           idempotency_key,request_hash,method,state,outcome,reason,at)
          VALUES (?,?,'live',?,?,?,?,'scanner',?,?,?,?,'camera','done','refused',?,?)`,
          [
            id,
            f.kit.org.id,
            passId,
            templateId,
            f.scanner.id,
            f.event.id,
            f.scanner.id,
            `s:${f.scanner.id}`,
            id,
            id,
            passId ? 'voided' : 'not_found',
            at,
          ],
        ),
      };
    };
    const at = f.kit.clock.now() + 1;
    const eligible = Array.from({ length: 19 }, () => insert(f.pass.id, f.template, at));
    const results = await f.kit.env.DB.batch(eligible.map(({ statement }) => statement));
    expect(results).toHaveLength(19);
    expect(results.every((result) => result.meta.changes === 1)).toBe(true);

    const expectedIds = [
      ...eligible
        .map(({ id }) => id)
        .sort()
        .reverse(),
      f.scanId,
    ];
    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())]) {
      expect(rows.map(({ id }) => id)).toEqual(expectedIds);
      expect(rows.slice(0, 19)).toEqual(
        eligible.map(() =>
          expect.objectContaining({ outcome: 'refused', passId: null, title: null }),
        ),
      );
      expect(rows[19]).toMatchObject({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME });
    }
  }, 120_000);

  it('limits lookup-disabled devices to their own activity without narrowing the console', async () => {
    const f = await activityFixture();
    const coworker = await f.kit.scanner({ eventId: f.event.id });
    await attach(f.kit, coworker, f.sessionId);
    const pass = await f.kit.scanPass(f.template, { memberName: 'Coworker guest' });
    const scanId = await record(f.kit, coworker, pass);
    expect(await deviceRows(await f.device())).toContainEqual(
      expect.objectContaining({ id: scanId, passId: pass.id, title: 'Coworker guest' }),
    );
    await run(f.kit.env.DB, 'UPDATE scanning_devices SET overrides=? WHERE scanner_id=?', [
      JSON.stringify({ lookup: false }),
      f.scanner.id,
    ]);
    const device = await deviceRows(await f.device());
    expect(device).toEqual([
      expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
    ]);
    expect(JSON.stringify(device)).not.toContain(pass.id);
    expect(JSON.stringify(device)).not.toContain('Coworker guest');
    const console = await consoleRows(await f.console());
    expect(console).toHaveLength(2);
    expect(console).toContainEqual(
      expect.objectContaining({ id: scanId, passId: pass.id, title: 'Coworker guest' }),
    );
  });

  it('does not carry the previous event into a scanner moved to this event', async () => {
    const f = await activityFixture();
    const oldEvent = await f.kit.event({ templateIds: [f.template] });
    const moved = await f.kit.scanner({ eventId: oldEvent.id });
    await workspace(f.kit, moved, { eventId: oldEvent.id });
    const oldPass = await f.kit.scanPass(f.template, { memberName: 'Previous event guest' });
    const oldScan = await record(f.kit, moved, oldPass);
    await run(f.kit.env.DB, 'UPDATE scanners SET event_id=?,updated_at=updated_at+1 WHERE id=?', [
      f.event.id,
      moved.id,
    ]);
    await run(f.kit.env.DB, 'UPDATE scanning_devices SET session_id=? WHERE scanner_id=?', [
      f.sessionId,
      moved.id,
    ]);
    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())]) {
      expect(rows).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      expect(rows.some((row) => row.id === oldScan)).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(oldPass.id);
      expect(JSON.stringify(rows)).not.toContain('Previous event guest');
    }
  });

  it('does not expose an out-of-scope template after a scanner is reassigned', async () => {
    const f = await activityFixture();
    await run(
      f.kit.env.DB,
      'UPDATE scanning_sessions SET accepts=?,updated_at=updated_at+1 WHERE id=?',
      [JSON.stringify({ templateIds: [f.template] }), f.sessionId],
    );
    const oldTemplate = await f.kit.scanTemplate('Previous template', { actions: [ACTION] });
    const moved = await f.kit.scanner({ templateIds: [oldTemplate] });
    await workspace(f.kit, moved, { templateIds: [oldTemplate] });
    const oldPass = await f.kit.scanPass(oldTemplate, { memberName: 'Previous template guest' });
    const oldScan = await record(f.kit, moved, oldPass);
    await run(f.kit.env.DB, 'DELETE FROM scanner_templates WHERE scanner_id=?', [moved.id]);
    await run(f.kit.env.DB, 'INSERT INTO scanner_templates(scanner_id,template_id) VALUES(?,?)', [
      moved.id,
      f.template,
    ]);
    await run(f.kit.env.DB, 'UPDATE scanning_devices SET session_id=? WHERE scanner_id=?', [
      f.sessionId,
      moved.id,
    ]);
    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())]) {
      expect(rows).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      expect(rows.some((row) => row.id === oldScan)).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(oldPass.id);
      expect(JSON.stringify(rows)).not.toContain('Previous template guest');
    }
  });

  it('never mixes real Test-mode or foreign-tenant scans into the Live activity', async () => {
    const f = await activityFixture();
    const testEvent = await f.kit.event({ mode: 'test', templateIds: [f.template] });
    const testScanner = await f.kit.scanner({ mode: 'test', eventId: testEvent.id });
    await workspace(f.kit, testScanner, { eventId: testEvent.id });
    const testPass = await f.kit.scanPass(
      f.template,
      { memberName: 'Sandbox guest' },
      { mode: 'test' },
    );
    const testScan = await record(f.kit, testScanner, testPass);
    const foreignOrg = await makeOrg(f.kit.fx);
    const foreignTemplate = await f.kit.scanTemplate(
      'Other tenant',
      { actions: [ACTION] },
      { orgId: foreignOrg.id },
    );
    const foreignEvent = await f.kit.event({
      orgId: foreignOrg.id,
      templateIds: [foreignTemplate],
    });
    const foreignScanner = await f.kit.scanner({ orgId: foreignOrg.id, eventId: foreignEvent.id });
    await workspace(f.kit, foreignScanner, { eventId: foreignEvent.id });
    const foreignPass = await f.kit.scanPass(
      foreignTemplate,
      { memberName: 'Foreign tenant guest' },
      { orgId: foreignOrg.id },
    );
    const foreignScan = await record(f.kit, foreignScanner, foreignPass);
    // A device can be reattached across modes in one org, but never across orgs.
    await run(f.kit.env.DB, 'UPDATE scanning_devices SET session_id=? WHERE scanner_id=?', [
      f.sessionId,
      testScanner.id,
    ]);
    // A conflicting scan reference is legal to store, but its retained proof is invalidated.
    await runOne(f.kit.env.DB, 'UPDATE scans SET scanner_id=? WHERE id=?', [
      f.scanner.id,
      foreignScan,
    ]);
    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())]) {
      expect(rows).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      for (const value of [
        testScan,
        testPass.id,
        'Sandbox guest',
        foreignScan,
        foreignPass.id,
        'Foreign tenant guest',
      ])
        expect(JSON.stringify(rows)).not.toContain(value);
    }
  });

  it('returns proven Test activity only in Test mode', async () => {
    const f = await activityFixture({ mode: 'test' });
    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())])
      expect(rows).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
    await noLeak(
      await f.console({ ...f.browser.headers, 'x-passbook-mode': 'live' }),
      404,
      'SCANNING_SESSION_NOT_FOUND',
      f.pass.id,
      ACTIVITY_NAME,
    );
  });
});

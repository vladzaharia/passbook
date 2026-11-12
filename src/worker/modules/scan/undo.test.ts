import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import {
  expectNoUndo,
  kit,
  legacyScenario,
  raceBatch,
  scenario,
  templateId,
  withEpochs,
} from './repo-undo-authority-test-fixtures.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';
import { undo } from './undo.ts';

describe('undo commit authority', () => {
  it('commits and replays once, removing a first presence', async () => {
    const s = await scenario();
    const req = { idempotencyKey: key() };
    const { outcome: result, evaluatedSnapshot } = await undo(kit.ctx, s.actor, s.targetId, req);
    expect(result).toMatchObject({ kind: 'ok', replay: false });
    expect(evaluatedSnapshot).toMatchObject({ pass: { id: s.pass.id, orgId: kit.org.id } });
    expect(JSON.stringify(result)).not.toContain('evaluatedSnapshot');
    const replay = await undo(kit.ctx, s.actor, s.targetId, req);
    expect(replay.outcome).toMatchObject({ kind: 'ok', replay: true, scanId: result.scanId });
    expect(replay.evaluatedSnapshot).toMatchObject({ pass: { id: s.pass.id, orgId: kit.org.id } });
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scan_presence WHERE pass_id=?', [s.pass.id]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT count(*) AS n FROM pass_events WHERE pass_id=? AND kind='scan.undone'",
        [s.pass.id],
      ),
    ).toEqual({ n: 1 });
    expect(
      await first(
        kit.env.DB,
        "SELECT count(*) AS n FROM audit_log WHERE target_id=? AND action='scan.undo'",
        [s.targetId],
      ),
    ).toEqual({ n: 1 });
    expect(
      await first(
        kit.env.DB,
        'SELECT state,count,last_scan_id,prev_state FROM scan_gates WHERE pass_id=?',
        [s.pass.id],
      ),
    ).toEqual({ state: 'undone', count: 0, last_scan_id: result.scanId, prev_state: null });
    expect(
      await first(
        kit.env.DB,
        'SELECT undone_by, undoes FROM scans WHERE id IN (?, ?) ORDER BY at',
        [s.targetId, result.scanId ?? ''],
      ),
    ).toEqual({ undone_by: result.scanId, undoes: null });
  });

  it('writes a plain undo event: no actor snapshot, proof or secret', async () => {
    const s = await scenario();
    await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() });
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id=? AND kind='scan.undone'",
      [s.pass.id],
    );
    const data = JSON.parse(event?.data ?? 'null');
    expect(data).toMatchObject({ undoes: s.targetId, actionKind: 'undo', outcome: 'ok' });
    expect(data).not.toHaveProperty('authority');
    expect(event?.data).not.toMatch(/csrf|proof|keyset|mac/i);
  });

  it('rolls back the gate and all undo effects if the ledger insert is omitted', async () => {
    const s = await scenario();
    const undoKey = key();
    await run(
      kit.env.DB,
      `CREATE TRIGGER omit_undo_ledger BEFORE INSERT ON pass_events
      WHEN NEW.kind='scan.undone' BEGIN SELECT RAISE(ABORT, 'ledger refused'); END`,
    );
    await expect(undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: undoKey })).rejects.toThrow();
    await run(kit.env.DB, 'DROP TRIGGER omit_undo_ledger');
    await expectNoUndo(s, undoKey);
  });

  it.each(['metadata-only', 'nonobject Wallet inputs', 'metadata-only template upgrade'] as const)(
    'undoes a valid scan with independent %s',
    async (change) => {
      const scanner = await kit.scanner({
        templateIds: [templateId],
        settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
      });
      const pass = await kit.scanPass(templateId);
      const response = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'enter',
      });
      const checkIn = (await response.json()) as ScanOutcome;
      expect(checkIn).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
      // The pass changes after the scan: none of this is authority for the undo.
      if (change === 'metadata-only')
        await run(
          kit.env.DB,
          "UPDATE passes SET version=version+1,personalization=json_set(personalization,'$.memberName','Updated Person') WHERE id=?",
          [pass.id],
        );
      else if (change === 'nonobject Wallet inputs')
        await run(
          kit.env.DB,
          "UPDATE pass_versions SET personalization='[]' WHERE pass_id=? AND version=?",
          [pass.id, pass.version],
        );
      else {
        const pinned = await kit.registry.resolve(templateId, pass.templateVersion);
        const next = kit.registry.add({
          id: templateId,
          orgId: kit.org.id,
          version: 'v2',
          manifest: pinned.manifest,
          passJson: pinned.passJson,
          assets: { 'icon.png': ICON_PNG },
        });
        await persistTemplate(kit.fx, next, { registry: kit.registry });
        const release = await approveAppleRelease(kit, {
          templateId,
          mode: 'live',
          version: next.version,
        });
        await run(
          kit.env.DB,
          'UPDATE passes SET version=version+1,template_version=?,release_id=? WHERE id=?',
          [next.version, release.id, pass.id],
        );
      }
      const row = await getScanner(kit.env.DB, scanner.id);
      if (!row || !checkIn.scanId) throw new Error('Missing scanner or scan');
      const scope = await readScannerScope(kit.env.DB, row, null);
      const actor = await withEpochs(
        row,
        await proofedScanActor(
          kit.ctx,
          withRole(scannerActor(kit.ctx, row, 'live', 'cookie', scope), null),
        ),
      );
      const request = { idempotencyKey: key() };
      const undone = await undo(kit.ctx, actor, checkIn.scanId, request);
      expect(undone.outcome).toMatchObject({ kind: 'ok', replay: false });
      expect((await undo(kit.ctx, actor, checkIn.scanId, request)).outcome).toMatchObject({
        kind: 'ok',
        replay: true,
        scanId: undone.outcome.scanId,
      });
    },
  );

  it('undoes and replays a legacy no-head scan, and after its first approval', async () => {
    const s = await legacyScenario();
    const req = { idempotencyKey: key() };
    const firstUndo = await undo(kit.ctx, s.actor, s.targetId, req);
    expect(firstUndo.outcome).toMatchObject({ kind: 'ok', replay: false });
    await approveAppleRelease(kit, {
      templateId: s.legacyTemplateId,
      mode: 'live',
      version: s.version,
    });
    expect((await undo(kit.ctx, s.actor, s.targetId, req)).outcome).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: firstUndo.outcome.scanId,
    });
  });

  it('undoes a legacy scan when its first approved head appears at commit', async () => {
    const s = await legacyScenario();
    const race = raceBatch('UPDATE scan_gates SET state', async (db) => {
      await approveAppleRelease(kit, {
        db,
        templateId: s.legacyTemplateId,
        mode: 'live',
        version: s.version,
      });
    });
    const result = await undo(race.ctx, s.actor, s.targetId, { idempotencyKey: key() });
    expect(race.raced()).toBe(true);
    expect(result.outcome).toMatchObject({ kind: 'ok', replay: false });
  });

  it.each([
    'activeReleaseId',
    'activeReleaseGeneration',
    'activeReleaseVersion',
    'activeReleaseCandidateHash',
  ] as const)('undoes a scan whose old check-in ledger omits %s', async (field) => {
    const s = await legacyScenario();
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data=json_remove(data,?) WHERE pass_id=? AND kind='scan.checked_in'",
      [`$.authority.${field}`, s.pass.id],
    );
    expect(
      (await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok', replay: false });
  });

  it('restores the previous presence on a valid undo', async () => {
    const s = await scenario();
    const response = await kit.post(s.scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(s.pass),
      clientTs: kit.clock.now(),
      actionId: 'enter',
    });
    const exit = (await response.json()) as ScanOutcome;
    expect(exit).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
    if (!exit.scanId) throw new Error('Missing exit scan');
    await undo(kit.ctx, s.actor, exit.scanId, { idempotencyKey: key() });
    expect(
      await first(kit.env.DB, 'SELECT state,last_scan_id FROM scan_presence WHERE pass_id=?', [
        s.pass.id,
      ]),
    ).toEqual({ state: 'in', last_scan_id: s.targetId });
  });
});

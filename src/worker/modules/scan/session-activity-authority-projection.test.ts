import { describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  ACTIVITY_NAME,
  activityFixture,
  attach,
  consoleRows,
  deviceRows,
  record,
} from './repo-session-activity-authority-test-fixtures.ts';
import { startScanCredentialTransfer } from './test-kit.ts';

describe('session activity projection', () => {
  it('intersects the event-time and current viewer roles instead of exposing a manager-only title', async () => {
    const f = await activityFixture({ role: 'manager', record: false });
    const base = await f.kit.registry.resolve(f.template, 'v1');
    const manifest = structuredClone(base.manifest);
    manifest.inputs.properties!.memberName = { type: 'string', minLength: 1, 'x-scan': 'manager' };
    manifest.display.title = '{{memberName}}';
    const restricted = f.kit.registry.add({
      id: f.template,
      orgId: f.kit.org.id,
      version: 'v2',
      manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(f.kit.fx, restricted, { registry: f.kit.registry });
    await approveAppleRelease(f.kit, { templateId: f.template, version: 'v2', mode: 'live' });
    const pass = await f.kit.scanPass(f.template, { memberName: 'Members Lounge' });
    const scanId = await record(f.kit, f.scanner, pass);
    const door = await f.kit.staff('door');
    const viewer = await f.kit.scanner({
      eventId: f.event.id,
      staffId: door.id,
      settings: { staffSignIn: true },
    });
    await attach(f.kit, viewer, f.sessionId);
    const managerRows = [await deviceRows(await f.device()), await consoleRows(await f.console())];
    for (const rows of managerRows)
      expect(rows).toEqual([
        expect.objectContaining({ id: scanId, passId: pass.id, title: 'Members Lounge' }),
      ]);
    const doorRows = [
      await deviceRows(await f.request('/scan/activity', viewer.headers)),
      await consoleRows(await f.console(f.reader.headers)),
    ];
    for (const rows of doorRows) {
      expect(rows).toEqual([expect.objectContaining({ id: scanId, passId: pass.id, title: null })]);
      expect(JSON.stringify(rows)).not.toContain('Members Lounge');
    }
  });

  it('never projects an unproven cached display title', async () => {
    const f = await activityFixture();
    await run(f.kit.env.DB, 'UPDATE passes SET display_title=? WHERE id=?', [
      'Injected private title',
      f.pass.id,
    ]);
    for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())]) {
      expect(rows).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      expect(JSON.stringify(rows)).not.toContain('Injected private title');
    }
  });

  it.each([
    'removed',
    'voided',
    'deleted',
    'wallet voided',
    'wallet expired',
    'quarantined',
    'completed transfer',
    'pending transfer',
  ] as const)(
    'keeps an unaffected proven row but cannot expose the %s pass or title',
    async (change) => {
      const f = await activityFixture();
      const pass = await f.kit.scanPass(f.template, { memberName: 'Unavailable activity guest' });
      const scanId = await record(f.kit, f.scanner, pass);
      const db = f.kit.env.DB;
      if (change === 'removed')
        await run(db, 'UPDATE passes SET removed_at=? WHERE id=?', [f.kit.clock.now(), pass.id]);
      if (change === 'voided')
        await run(db, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
      if (change === 'deleted')
        await run(db, 'UPDATE passes SET deleted_at=? WHERE id=?', [f.kit.clock.now(), pass.id]);
      if (change === 'wallet voided')
        await run(
          db,
          "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.voided',json('true')) WHERE pass_id=?",
          [pass.id],
        );
      if (change === 'wallet expired')
        await run(
          db,
          "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=?",
          [new Date(f.kit.clock.now() - 86_400_000).toISOString(), pass.id],
        );
      if (change === 'quarantined')
        await run(db, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [pass.id]);
      if (change === 'completed transfer')
        expect(await startScanCredentialTransfer(f.kit, pass.id)).toMatchObject({
          state: 'completed',
        });
      if (change === 'pending transfer')
        await stagePendingCredentialTransfer(db, pass.id, {
          id: f.kit.fx.ids.ordered(),
          token: f.kit.fx.ids.token(),
          now: f.kit.clock.now(),
          targetHolderEmail: 'incoming@example.test',
        });
      for (const rows of [
        await deviceRows(await f.device()),
        await consoleRows(await f.console()),
      ]) {
        expect(rows).toContainEqual(
          expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
        );
        const hidden = rows.find((row) => row.id === scanId);
        if (hidden) expect(hidden).toMatchObject({ passId: null, title: null });
        expect(JSON.stringify(rows)).not.toContain(pass.id);
        expect(JSON.stringify(rows)).not.toContain('Unavailable activity guest');
      }
    },
  );
});

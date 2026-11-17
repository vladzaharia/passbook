import { describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { run } from '../../platform/db.ts';
import {
  ACTION,
  ACTIVITY_NAME,
  activityFixture,
  atActivityRead,
  consoleRows,
  deviceRows,
  noLeak,
  record,
} from './repo-session-activity-authority-test-fixtures.ts';
import { approveScanReleases, startScanCredentialTransfer } from './test-kit.ts';

const changes = [
  'removed',
  'wallet voided',
  'completed transfer',
  'pending transfer',
  'personalization',
  'event tampered',
  'event templates',
  'release head',
] as const;
const cases = (['device', 'console'] as const).flatMap((consumer) =>
  (['before', 'after'] as const).flatMap((when) =>
    changes.map((change) => [consumer, when, change] as const),
  ),
);

/*
 * The activity page is one snapshot: a change made before the page statement is in the snapshot
 * (the row is redacted or gone), a change made after it is not (the answer is the snapshot's, and
 * the next request shows the change).
 */
describe('session activity output races', () => {
  it.each(cases)(
    '%s activity with a change made %s the page read: %s',
    async (consumer, when, change) => {
      const f = await activityFixture();
      const victimTemplate = await f.kit.scanTemplate('Activity race victim', {
        actions: [ACTION],
      });
      await run(
        f.kit.env.DB,
        'INSERT INTO scan_event_templates(event_id,template_id) VALUES(?,?)',
        [f.event.id, victimTemplate],
      );
      const victim = await f.kit.scanPass(victimTemplate, { memberName: 'Race victim guest' });
      const victimScan = await record(f.kit, f.scanner, victim);
      const operation = consumer === 'device' ? f.device : f.console;
      const read = async (response: Response) =>
        consumer === 'device' ? deviceRows(response) : consoleRows(response);
      // Control: before the change, both rows show their pass and title.
      const control = await read(await operation());
      expect(control).toContainEqual(
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      );
      expect(control).toContainEqual(
        expect.objectContaining({ id: victimScan, passId: victim.id, title: 'Race victim guest' }),
      );
      const mutate = async (db: D1Database) => {
        if (change === 'removed')
          await run(db, 'UPDATE passes SET removed_at=? WHERE id=?', [
            f.kit.clock.now(),
            victim.id,
          ]);
        if (change === 'wallet voided')
          await run(
            db,
            "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.voided',json('true')) WHERE pass_id=?",
            [victim.id],
          );
        if (change === 'completed transfer')
          expect(await startScanCredentialTransfer(f.kit, victim.id, { db })).toMatchObject({
            state: 'completed',
          });
        if (change === 'pending transfer')
          await stagePendingCredentialTransfer(db, victim.id, {
            id: f.kit.fx.ids.ordered(),
            token: f.kit.fx.ids.token(),
            now: f.kit.clock.now(),
            targetHolderEmail: 'incoming@example.test',
          });
        if (change === 'personalization')
          await run(
            db,
            "UPDATE passes SET personalization=json_set(personalization,'$.memberName','Replacement guest') WHERE id=?",
            [victim.id],
          );
        if (change === 'event tampered')
          await run(
            db,
            `UPDATE pass_events SET data=json_set(data,'$.authority.pinnedTemplateVersion','forged')
            WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
            [victim.id, victimScan],
          );
        if (change === 'event templates')
          await run(db, 'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?', [
            f.event.id,
            victimTemplate,
          ]);
        if (change === 'release head')
          await approveScanReleases(f.kit, victimTemplate, { modes: ['live'], db });
      };
      const response = await atActivityRead(f.kit.env, operation, mutate, { when });
      if (when === 'before' && consumer === 'device' && change === 'event templates') {
        // The scanner's own scope shrank: configuration, so the device stays paired.
        await noLeak(response, 409, 'SCAN_CONFIG_CHANGED', victim.id, 'Race victim guest');
        return;
      }
      const rows = await read(response);
      expect(rows).toContainEqual(
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      );
      if (when === 'after' || change === 'release head') {
        // The snapshot predates the change: the victim shows as it did. A new release head is
        // content, not authority.
        expect(rows).toContainEqual(
          expect.objectContaining({
            id: victimScan,
            passId: victim.id,
            title: 'Race victim guest',
          }),
        );
        return;
      }
      const stale = rows.find((row) => row.id === victimScan);
      expect(JSON.stringify(rows)).not.toContain('Race victim guest');
      expect(JSON.stringify(rows)).not.toContain('Replacement guest');
      // A changed title is withheld by the signed title commitment; the pass itself is still the
      // event's. Every other change takes the pass away.
      if (change === 'personalization') {
        expect(stale).toMatchObject({ passId: victim.id, title: null });
        return;
      }
      if (stale) expect(stale).toMatchObject({ passId: null, title: null, deviceName: 'Scanner' });
      expect(JSON.stringify(rows)).not.toContain(victim.id);
    },
  );

  it('redacts a removed pass in the next console read', async () => {
    const f = await activityFixture();
    await run(f.kit.env.DB, 'UPDATE passes SET removed_at=? WHERE id=?', [
      f.kit.clock.now(),
      f.pass.id,
    ]);
    const rows = await consoleRows(await f.console());
    expect(rows).toEqual([
      expect.objectContaining({ id: f.scanId, passId: null, title: null, deviceName: 'Scanner' }),
    ]);
  });
});

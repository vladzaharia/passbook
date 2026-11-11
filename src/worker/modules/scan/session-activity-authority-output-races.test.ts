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
  changes.map((change) => [consumer, change] as const),
);

describe('session activity output races', () => {
  it.each(['device', 'console'] as const)(
    'fails unavailable for a missing %s activity result, not a fabricated empty page',
    async (consumer) => {
      const f = await activityFixture();
      const response = await atActivityRead(
        f.kit.env,
        consumer === 'device' ? f.device : f.console,
        async () => {},
        { omitFinalRows: true },
      );
      await noLeak(response, 503, 'SCANNING_ACTIVITY_UNAVAILABLE', f.pass.id, ACTIVITY_NAME);
    },
  );

  it.each(['device', 'console'] as const)(
    'redacts a %s row if a final proof fragment is missing',
    async (consumer) => {
      const f = await activityFixture();
      const response = await atActivityRead(
        f.kit.env,
        consumer === 'device' ? f.device : f.console,
        async () => {},
        { omitProofRows: true },
      );
      const rows = consumer === 'device' ? await deviceRows(response) : await consoleRows(response);
      expect(rows).toEqual([
        expect.objectContaining({
          id: f.scanId,
          passId: null,
          title: null,
          deviceName: 'Scanner',
          direction: null,
        }),
      ]);
      expect(JSON.stringify(rows)).not.toContain(f.pass.id);
      expect(JSON.stringify(rows)).not.toContain(ACTIVITY_NAME);
    },
  );

  it.each(cases)(
    'revalidates %s activity when %s changes at the final batch',
    async (consumer, change) => {
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
      const before =
        consumer === 'device'
          ? await deviceRows(await operation())
          : await consoleRows(await operation());
      expect(before).toContainEqual(
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      );
      expect(before).toContainEqual(
        expect.objectContaining({ id: victimScan, passId: victim.id, title: 'Race victim guest' }),
      );
      const response = await atActivityRead(f.kit.env, operation, async (db) => {
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
            `UPDATE pass_events SET data=json_set(data,'$.tampered',json('true'))
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
      });
      if (consumer === 'device' && change === 'event templates') {
        // The scanner's own scope shrank: its credential no longer covers this read.
        await noLeak(response, 401, 'SCANNER_UNAUTHENTICATED', victim.id, 'Race victim guest');
        return;
      }
      const rows = consumer === 'device' ? await deviceRows(response) : await consoleRows(response);
      expect(rows).toContainEqual(
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      );
      // A new release head is content: the victim's row stays as it was. Every other change hides it.
      if (change === 'release head') return;
      const stale = rows.find((row) => row.id === victimScan);
      if (stale) expect(stale).toMatchObject({ passId: null, title: null });
      expect(JSON.stringify(rows)).not.toContain(victim.id);
      expect(JSON.stringify(rows)).not.toContain('Race victim guest');
      expect(JSON.stringify(rows)).not.toContain('Replacement guest');
    },
  );
});

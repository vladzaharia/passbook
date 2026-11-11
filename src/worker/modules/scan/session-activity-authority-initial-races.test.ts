import { describe, expect, it } from 'vitest';
import { makeSession, runOne } from '../../../../test/helpers/index.ts';
import {
  ACTIVITY_NAME,
  activityFixture,
  atActivityRead,
  consoleRows,
  deviceRows,
  noLeak,
} from './repo-session-activity-authority-test-fixtures.ts';
import { approveScanReleases } from './test-kit.ts';

const races = [
  ['device', 'revoked scanner'],
  ['device', 'rotated csrf'],
  ['device', 'changed binding'],
  ['console', 'revoked membership'],
  ['console', 'rotated session'],
  ['device', 'event revision'],
  ['console', 'event revision'],
  ['device', 'release head'],
  ['console', 'release head'],
] as const;

describe('initial session activity authority batch', () => {
  it.each(races)(
    'rejects a %s read when %s changes after the original authorization',
    async (consumer, change) => {
      const f = await activityFixture();
      const operation = consumer === 'device' ? f.device : f.console;
      const before =
        consumer === 'device'
          ? await deviceRows(await operation())
          : await consoleRows(await operation());
      expect(before).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      const response = await atActivityRead(
        f.kit.env,
        operation,
        async (db) => {
          if (change === 'revoked scanner')
            await runOne(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
              f.kit.clock.now(),
              f.scanner.id,
            ]);
          if (change === 'rotated csrf')
            await runOne(
              db,
              'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
              ['replacement-device-secret', f.scanner.id],
            );
          if (change === 'changed binding')
            await runOne(db, "UPDATE scanning_devices SET mode='test' WHERE scanner_id=?", [
              f.scanner.id,
            ]);
          if (change === 'revoked membership')
            await runOne(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
              f.kit.clock.now(),
              f.membershipId,
            ]);
          if (change === 'rotated session') {
            const fx = { ...f.kit.fx, env: { ...f.kit.fx.env, DB: db } };
            await makeSession(fx, { userId: f.user.id });
            await runOne(db, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
              f.kit.clock.now(),
              f.auth.sessionId,
            ]);
          }
          if (change === 'event revision')
            await runOne(
              db,
              "UPDATE scan_events SET name='Changed',updated_at=updated_at+1 WHERE id=?",
              [f.event.id],
            );
          if (change === 'release head')
            await approveScanReleases(f.kit, f.template, { modes: ['live'], db });
        },
        { phase: 'initial' },
      );
      await noLeak(
        response,
        consumer === 'device' ? 401 : 404,
        consumer === 'device' ? 'SCANNER_UNAUTHENTICATED' : 'SCANNING_SESSION_NOT_FOUND',
        f.pass.id,
        ACTIVITY_NAME,
      );
    },
  );
});

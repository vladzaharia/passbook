import { describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { credentialTombstoneRef } from '../passes/credential-tombstones.ts';
import type { Pass } from '../passes/repo.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { scanningSessionRow } from './repo-scanning-sessions.ts';
import { type ActivityCandidate, activityCredentialFenceStmt } from './repo-session-activity.ts';
import {
  ACTIVITY_NAME,
  activityFixture,
  atActivityRead,
  consoleRows,
  deviceRows,
} from './repo-session-activity-authority-test-fixtures.ts';
import { type ScanKit, startScanCredentialTransfer } from './test-kit.ts';

interface Fixture {
  kit: ScanKit;
  template: string;
  pass: Pass;
}
type Mode = 'live' | 'test';

async function overlappingPass(f: Fixture, mode: Mode) {
  const donor = await f.kit.scanPass(
    f.template,
    { memberName: 'Other credential owner' },
    { mode },
  );
  const code = f.pass.scanCode;
  if (!code) throw new Error('The scanned pass has no scanner credential');
  await runOne(f.kit.env.DB, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
    await barcodeHashOfCode(cleanCode(code)),
    donor.id,
  ]);
  return donor;
}

async function retireOverlap(f: Fixture, db: D1Database, donorId: string, mode: Mode) {
  const code = f.pass.scanCode;
  if (!code) throw new Error('The scanned pass has no scanner credential');
  const ref = await credentialTombstoneRef(
    f.kit.env,
    f.kit.org.id,
    mode,
    await barcodeHashOfCode(cleanCode(code)),
  );
  expect(await startScanCredentialTransfer(f.kit, donorId, { db })).toMatchObject({
    state: 'completed',
  });
  expect(
    await first(
      db,
      `SELECT credential_hash FROM pass_credential_tombstones
    WHERE pass_id=? AND org_id=? AND mode=? AND credential_hash=?`,
      [donorId, f.kit.org.id, mode, ref],
    ),
  ).toEqual({ credential_hash: ref });
}

describe('mode-scoped activity credential fences', () => {
  it.each(['live', 'test'] as const)(
    'keeps %s passful activity after an other-mode retirement, but redacts an own-mode retirement',
    async (mode) => {
      const f = await activityFixture({ mode });
      const otherMode = mode === 'live' ? 'test' : 'live';
      const other = await overlappingPass(f, otherMode);
      await retireOverlap(f, f.kit.env.DB, other.id, otherMode);
      for (const rows of [await deviceRows(await f.device()), await consoleRows(await f.console())])
        expect(rows).toEqual([
          expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
        ]);
      const own = await overlappingPass(f, mode);
      await retireOverlap(f, f.kit.env.DB, own.id, mode);
      for (const rows of [
        await deviceRows(await f.device()),
        await consoleRows(await f.console()),
      ]) {
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
      }
    },
  );

  const races = (['device', 'console'] as const).flatMap((consumer) =>
    (['other', 'own'] as const).map((retired) => [consumer, retired] as const),
  );
  it.each(races)(
    'rechecks %s activity when an %s-mode credential retires at the final batch',
    async (consumer, retired) => {
      const f = await activityFixture();
      const mode = retired === 'other' ? 'test' : 'live';
      const donor = await overlappingPass(f, mode);
      const operation = consumer === 'device' ? f.device : f.console;
      const before =
        consumer === 'device'
          ? await deviceRows(await operation())
          : await consoleRows(await operation());
      expect(before).toEqual([
        expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
      ]);
      const response = await atActivityRead(f.kit.env, operation, (db) =>
        retireOverlap(f, db, donor.id, mode),
      );
      const rows = consumer === 'device' ? await deviceRows(response) : await consoleRows(response);
      if (retired === 'other') {
        expect(rows).toEqual([
          expect.objectContaining({ id: f.scanId, passId: f.pass.id, title: ACTIVITY_NAME }),
        ]);
      } else {
        expect(rows).toEqual([
          expect.objectContaining({ id: f.scanId, passId: null, title: null }),
        ]);
        expect(JSON.stringify(rows)).not.toContain(f.pass.id);
        expect(JSON.stringify(rows)).not.toContain(ACTIVITY_NAME);
      }
    },
  );

  it('accepts an empty own-reference fence for a proven scan', async () => {
    const f = await activityFixture();
    const row = await scanningSessionRow(f.kit.env.DB, f.kit.org.id, f.sessionId);
    const candidate = await first<ActivityCandidate>(
      f.kit.env.DB,
      `SELECT s.id,s.at,s.scanner_id AS deviceId,
      scanner.name AS deviceName,s.pass_id AS passId,s.event_id AS eventId,s.template_id AS templateId,
      s.outcome,s.direction,p.serial,p.scan_code AS scanCode,p.barcode_hash AS barcodeHash,p.lookup_hash AS lookupHash,
      NULL AS barcodeMessage,NULL AS lookupValue FROM scans s JOIN passes p ON p.id=s.pass_id
      JOIN scanners scanner ON scanner.id=s.scanner_id WHERE s.id=?`,
      [f.scanId],
    );
    if (!row || !candidate) throw new Error('Missing the proven activity candidate');
    expect(await activityCredentialFenceStmt(f.kit.env.DB, row, candidate, []).first()).toEqual({
      id: f.scanId,
    });
  });
});

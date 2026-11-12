import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { atCountBatch, LEDGER_COUNT_BATCH } from './repo-session-stats-authority-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

/** The door polls `/stats`: drift under the count batch is a 409 it reloads, only a lost credential unpairs. */
describe('GET /scan/stats refusal classes', () => {
  async function door(staffSignIn: boolean) {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Stats drift', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const staff = staffSignIn ? await kit.staff('door') : null;
    const scanner = await kit.scanner({
      templateIds: [templateId],
      ...(staff ? { staffId: staff.id, settings: { staffSignIn: true } } : {}),
    });
    const stats = (change: (db: D1Database) => Promise<void>) =>
      atCountBatch(
        kit.env,
        () => kit.get(scanner.headers, '/stats'),
        change,
        undefined,
        LEDGER_COUNT_BATCH,
      );
    return { kit, scanner, staff, stats };
  }

  it('counts when nothing moved (control)', async () => {
    const { stats } = await door(true);
    const { result } = await stats(async () => {});
    expect(result.status).toBe(200);
  });

  it('answers 409 SCAN_CONFIG_CHANGED for a scanner configuration change, never an unpair', async () => {
    const { scanner, stats } = await door(false);
    const { result } = await stats(async (db) => {
      await run(db, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [scanner.id]);
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
  });

  it.each(['role', 'disabled', 'idle'] as const)(
    'answers 409 SCAN_STAFF_CHANGED when the signed-in staff member changes (%s)',
    async (change) => {
      const { kit, scanner, staff, stats } = await door(true);
      if (!staff) throw new Error('Missing staff member.');
      const { result } = await stats(async (db) => {
        if (change === 'role')
          await run(db, "UPDATE scan_staff SET role='desk' WHERE id=?", [staff.id]);
        if (change === 'disabled')
          await run(db, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
            kit.clock.now(),
            staff.id,
          ]);
        if (change === 'idle')
          await run(db, 'UPDATE scanners SET staff_seen_at=0 WHERE id=?', [scanner.id]);
      });
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: 'SCAN_STAFF_CHANGED' });
    },
  );

  it('answers 401 SCANNER_REPAIR only when the credential is gone', async () => {
    const { kit, scanner, stats } = await door(false);
    const { result } = await stats(async (db) => {
      await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), scanner.id]);
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ code: 'SCANNER_REPAIR' });
  });
});

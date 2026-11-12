import { describe, expect, it } from 'vitest';
import {
  ScanSessionSchema,
  ScanStaffSearchSchema,
} from '../../../shared/contracts/scan-session.ts';
import { run } from '../../platform/db.ts';
import { STAFF_ROSTER_LIMIT } from './repo-session.ts';
import { setupScanKit } from './test-kit.ts';

describe('a cut staff roster', () => {
  it('says so, and the name search finds people past the cut', async () => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Check-in', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { staffSignIn: true },
    });
    const total = STAFF_ROSTER_LIMIT + 5;
    await run(
      kit.env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO scan_staff (id, org_id, name, role, pin_hash, pin_set_at, created_at, updated_at)
       SELECT 'bulk-' || printf('%04d', i), ?, 'Person ' || printf('%04d', i), 'door', 'x', 1, 1, 1
       FROM n`,
      [total, kit.org.id],
    );
    const response = await kit.get(scanner.headers, '/session');
    expect(response.status).toBe(200);
    const session = ScanSessionSchema.parse(await response.json());
    expect(session.staffList).toHaveLength(STAFF_ROSTER_LIMIT);
    expect(session.staffTruncated).toBe(true);
    const last = `Person ${String(total).padStart(4, '0')}`;
    expect(session.staffList?.some((p) => p.name === last)).toBe(false);

    const found = await kit.get(scanner.headers, `/staff?q=${encodeURIComponent(last)}`);
    expect(found.status).toBe(200);
    expect(ScanStaffSearchSchema.parse(await found.json()).items).toEqual([
      { id: `bulk-${String(total).padStart(4, '0')}`, name: last, role: 'door' },
    ]);
    expect((await kit.get(scanner.headers, '/staff?q=')).status).toBe(422);
  });

  it('is not flagged when the roster is whole', async () => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Check-in', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { staffSignIn: true },
    });
    await kit.staff('door', 'Only one');
    const session = ScanSessionSchema.parse(
      await (await kit.get(scanner.headers, '/session')).json(),
    );
    expect(session.staffTruncated).toBeUndefined();
  });
});

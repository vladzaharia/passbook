import { describe, expect, it } from 'vitest';
import { makeOrg, makeSession } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { listStaff } from './staff-admin.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';
import { key, setupScanKit } from './test-kit.ts';

setupStaffAdminTestKit();

describe('mode-specific staff activity and device PIN locks', () => {
  it.each(['not_found', 'ambiguous'] as const)(
    'retains a proven event-scoped %s after archive or deletion but excludes foreign and unsigned rows',
    async (reason) => {
      const kit = await setupScanKit();
      const template = await kit.scanTemplate('Staff event activity', {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
        lookup: { input: 'memberNo' },
      });
      const event = await kit.event({ templateIds: [template] });
      const person = await kit.staff('manager');
      const scanner = await kit.scanner({
        eventId: event.id,
        staffId: person.id,
        settings: { staffSignIn: true },
      });
      if (reason === 'ambiguous') {
        await kit.scanPass(template, { memberNo: 'AMB-1' });
        await kit.scanPass(template, { memberNo: 'AMB-1' });
      }
      const match = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input:
          reason === 'ambiguous'
            ? { code: 'amb 1', method: 'wedge' }
            : { code: 'NO-SUCH-PASS', method: 'camera' },
        actionId: 'auto',
        clientTs: kit.clock.now(),
      });
      expect(match.status).toBe(200);
      const receipt = (await match.json()) as {
        kind: string;
        reason: string;
        scanId: string | null;
      };
      expect(receipt).toMatchObject({ kind: 'refused', reason });
      if (!receipt.scanId) throw new Error('Missing no-match scan');
      const recorded = await first<{ at: number; event_id: string | null }>(
        kit.env.DB,
        'SELECT at, event_id FROM scans WHERE id = ?',
        [receipt.scanId],
      );
      if (!recorded) throw new Error('Missing no-match row');
      expect(recorded.event_id).toBe(event.id);
      const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['user'] });
      const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
      if (!session) throw new Error('Missing session');
      const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
      if (authority.kind !== 'session') throw new Error('Expected session authority');
      const latest = async () =>
        (await listStaff(kit.ctx, session, authority, kit.org.id, 'live')).items.find(
          (item) => item.id === person.id,
        )?.lastScan ?? null;
      expect(await latest()).toEqual({ at: recorded.at, scannerName: 'Scanner' });

      const other = await makeOrg(kit.fx);
      await run(kit.env.DB, 'UPDATE scan_events SET org_id = ? WHERE id = ?', [other.id, event.id]);
      expect(await latest()).toBeNull();
      await run(kit.env.DB, 'UPDATE scan_events SET org_id = ?, archived_at = ? WHERE id = ?', [
        kit.org.id,
        kit.clock.now(),
        event.id,
      ]);
      expect(await latest()).toEqual({ at: recorded.at, scannerName: 'Scanner' });
      await run(kit.env.DB, 'DELETE FROM scan_events WHERE id = ?', [event.id]);
      expect(await latest()).toEqual({ at: recorded.at, scannerName: 'Scanner' });
    },
  );
});

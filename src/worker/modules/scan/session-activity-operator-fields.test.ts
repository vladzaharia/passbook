import { describe, expect, it } from 'vitest';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import {
  ACTIVITY_NAME,
  activityFixture,
  consoleRows,
  deviceRows,
  record,
} from './repo-session-activity-authority-test-fixtures.ts';
import { key } from './test-kit.ts';

/** What the operator list reads beyond the first page's fields: reason, staff, method, undo, group. */
describe('session activity: operator fields', () => {
  it('names the scan, how it was read, and lets the recording device undo it', async () => {
    const f = await activityFixture();
    const [own] = await deviceRows(await f.device());
    expect(own).toMatchObject({
      id: f.scanId,
      scanId: f.scanId,
      reason: null,
      staff: null,
      undoable: true,
      groupSize: null,
    });
    expect(own?.method).not.toBeNull();
  });

  it('leaves undo to the device that made the scan, and only inside the window', async () => {
    const f = await activityFixture();
    const [seenByConsole] = await consoleRows(await f.console());
    expect(seenByConsole).toMatchObject({ scanId: f.scanId, undoable: false });
    f.kit.clock.advance(60 * 60_000);
    const [late] = await deviceRows(await f.device());
    expect(late).toMatchObject({ scanId: f.scanId, undoable: false });
  });

  it('gives the reason of an unknown code, which has no pass to disclose', async () => {
    const f = await activityFixture();
    f.kit.clock.advance(1);
    const response = await f.kit.post(f.scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { code: `NO-MATCH-${key()}`, method: 'camera' },
      clientTs: f.kit.clock.now(),
      actionId: 'check_in',
    });
    expect(ScanOutcomeSchema.parse(await response.json())).toMatchObject({ reason: 'not_found' });
    const [unknown] = await deviceRows(await f.device());
    expect(unknown).toMatchObject({
      passId: null,
      title: null,
      scanId: null,
      reason: 'not_found',
      method: null,
      undoable: false,
    });
  });

  it('names the staff to Desk and Manager devices, never to a Door device', async () => {
    for (const [role, shown] of [
      ['door', false],
      ['desk', true],
      ['manager', true],
    ] as const) {
      const f = await activityFixture({ role });
      const [row] = await deviceRows(await f.device());
      expect(row?.title).toBe(ACTIVITY_NAME);
      if (shown) expect(row?.staff).toEqual(expect.any(String));
      else expect(row?.staff).toBeNull();
    }
  });

  it('counts a group check-in on its anchor row', async () => {
    const f = await activityFixture();
    const other = await f.kit.scanPass(f.template, { memberName: 'Second family member' });
    const otherScan = await record(f.kit, f.scanner, other);
    for (const member of [f.scanId, otherScan])
      await run(
        f.kit.env.DB,
        'INSERT INTO scan_group_members (group_scan_id, scan_id, org_id) VALUES (?, ?, ?)',
        [f.scanId, member, f.kit.org.id],
      );
    const rows = await deviceRows(await f.device());
    expect(rows.find((row) => row.id === f.scanId)?.groupSize).toBe(2);
    expect(rows.find((row) => row.id === otherScan)?.groupSize).toBeNull();
  });

  it('has a problems page of its own: refusals and holds of the last 15 minutes, not the newest scans', async () => {
    const f = await activityFixture();
    const refuse = async () => {
      f.kit.clock.advance(1);
      const response = await f.kit.post(f.scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: { code: `NO-MATCH-${key()}`, method: 'camera' },
        clientTs: f.kit.clock.now(),
        actionId: 'check_in',
      });
      return ScanOutcomeSchema.parse(await response.json()).scanId;
    };
    const old = await refuse();
    f.kit.clock.advance(16 * 60_000);
    const fresh = await refuse();
    // Twenty-odd later check-ins push the refusal off the newest-scans page, not off Problems.
    for (let i = 0; i < 21; i += 1) {
      const pass = await f.kit.scanPass(f.template, { memberName: `Crowd ${i}` });
      await record(f.kit, f.scanner, pass);
    }
    const page = await deviceRows(await f.device());
    expect(page.some((row) => row.id === fresh)).toBe(false);
    const problems = await deviceRows(
      await f.request('/scan/activity?problems=1', f.scanner.headers),
    );
    expect(problems.map((row) => row.id)).toEqual([fresh]);
    expect(problems.some((row) => row.id === old)).toBe(false);
    expect(problems[0]).toMatchObject({ outcome: 'refused', reason: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { ScanSummarySchema } from '../../../shared/contracts/scan-session.ts';
import { run } from '../../platform/db.ts';
import { activityFixture } from './repo-session-activity-authority-test-fixtures.ts';
import { QUARTER } from './repo-summary-extras.ts';
import { hourBuckets } from './summary-session.ts';

const q = (iso: string, n = 1, refused = 0) => ({ q: Date.parse(iso) / QUARTER, n, refused });

describe('hourBuckets', () => {
  it('keeps the repeated hour of a fall-back change as two buckets', () => {
    // New York ends DST on 2026-11-01: 01:00 happens at 05:00Z (EDT) and again at 06:00Z (EST).
    const buckets = hourBuckets(
      [
        q('2026-11-01T04:30:00Z'),
        q('2026-11-01T05:15:00Z', 2),
        q('2026-11-01T05:45:00Z', 1, 1),
        q('2026-11-01T06:15:00Z', 4),
        q('2026-11-01T07:00:00Z'),
      ],
      'America/New_York',
    );
    expect(buckets.map((b) => [b.label, b.start, b.count, b.refused])).toEqual([
      ['00:00', Date.parse('2026-11-01T04:00:00Z'), 1, 0],
      ['01:00', Date.parse('2026-11-01T05:00:00Z'), 3, 1],
      ['01:00', Date.parse('2026-11-01T06:00:00Z'), 4, 0],
      ['02:00', Date.parse('2026-11-01T07:00:00Z'), 1, 0],
    ]);
  });

  it('skips the missing hour of a spring-forward change', () => {
    // New York starts DST on 2026-03-08: 02:00 does not exist; 01:59 EST is followed by 03:00 EDT.
    const buckets = hourBuckets(
      [q('2026-03-08T06:30:00Z'), q('2026-03-08T07:00:00Z')],
      'America/New_York',
    );
    expect(buckets.map((b) => b.label)).toEqual(['01:00', '03:00']);
  });

  it('puts a half-hour zone on its own local hours', () => {
    const buckets = hourBuckets(
      [q('2026-06-01T10:15:00Z'), q('2026-06-01T10:45:00Z')],
      'Asia/Kolkata',
    );
    expect(buckets.map((b) => [b.label, b.start, b.count])).toEqual([
      ['15:00', Date.parse('2026-06-01T09:30:00Z'), 1],
      ['16:00', Date.parse('2026-06-01T10:30:00Z'), 1],
    ]);
  });
});

describe('GET /scan/summary?scope=session', () => {
  it('gives a Manager the whole session, with staff, hours and overrides', async () => {
    const f = await activityFixture({ role: 'manager' });
    const response = await f.request('/scan/summary?scope=session', f.scanner.headers);
    expect(response.status).toBe(200);
    const summary = ScanSummarySchema.parse(await response.json());
    expect(summary).toMatchObject({ scope: 'session', total: 1, ok: 1, timeZone: 'UTC' });
    expect(summary.byHour).toHaveLength(1);
    expect(summary.byHour[0]?.count).toBe(1);
    expect(summary.byStaff).toEqual([
      { staffId: f.staff?.id, name: expect.any(String), count: 1, overrides: 0, refused: 0 },
    ]);
    expect(summary.overrides).toEqual({ count: 0, latest: [] });
    // By type: the one done scan, under its template's name; the rows sum to the done total.
    expect(summary.byType).toEqual([
      { templateId: expect.any(String), name: expect.any(String), count: 1 },
    ]);
    expect(summary.byType.reduce((n, t) => n + t.count, 0)).toBe(summary.ok);
  });

  it('lists the overrides with who ran them', async () => {
    const f = await activityFixture({ role: 'manager' });
    await run(f.kit.env.DB, 'UPDATE scans SET override_of = ? WHERE id = ?', ['earlier', f.scanId]);
    const response = await f.request('/scan/summary?scope=session', f.scanner.headers);
    const summary = ScanSummarySchema.parse(await response.json());
    expect(summary.overrides.count).toBe(1);
    expect(summary.overrides.latest[0]).toMatchObject({
      scanId: f.scanId,
      staffName: expect.any(String),
    });
    expect(summary.byStaff[0]?.overrides).toBe(1);
  });

  it.each(['door', 'desk'] as const)('refuses a %s', async (role) => {
    const f = await activityFixture({ role });
    const response = await f.request('/scan/summary?scope=session', f.scanner.headers);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('SCAN_SUMMARY_SESSION_FORBIDDEN');
    // The device scope stays open to every role.
    const device = await f.request('/scan/summary', f.scanner.headers);
    expect(device.status).toBe(200);
    expect(ScanSummarySchema.parse(await device.json())).toMatchObject({ scope: 'device' });
  });

  it('serves the console card to an admin, and refuses a read-only member', async () => {
    const f = await activityFixture({ role: 'manager' });
    const ok = await f.request(`/scanning-sessions/${f.sessionId}/summary`);
    expect(ok.status).toBe(200);
    expect(ScanSummarySchema.parse(await ok.json())).toMatchObject({ scope: 'session', total: 1 });
    const denied = await f.request(`/scanning-sessions/${f.sessionId}/summary`, f.reader.headers);
    expect(denied.status).toBeGreaterThanOrEqual(403);
    expect(denied.status).toBeLessThanOrEqual(404);
  });
});

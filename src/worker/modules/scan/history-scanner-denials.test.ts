import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_HISTORY_PAGE, tagRe } from './race-tags.ts';
import { ACTIVITY_NAME, activityFixture } from './repo-session-activity-authority-test-fixtures.ts';

/*
 * The denial matrix of the scanner's own history reads (recent, summary): each change made before
 * the page statement is refused with the class the guard uses elsewhere, and each has a positive
 * control that shows the same read succeeding. A change made after the page statement is the
 * snapshot's answer (scans-recent.test.ts).
 */

const PAGE = tagRe(RACE_HISTORY_PAGE);
type Fixture = Awaited<ReturnType<typeof activityFixture>>;

const reads = {
  recent: (f: Fixture) => f.request('/scan/scans?limit=10', f.scanner.headers),
  summary: (f: Fixture) => f.request('/scan/summary', f.scanner.headers),
} as const;

const denials: [string, (f: Fixture, db: D1Database) => Promise<unknown>, number, string][] = [
  [
    'a revoked scanner',
    (f, db) =>
      run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [f.kit.clock.now(), f.scanner.id]),
    401,
    'SCANNER_REPAIR',
  ],
  [
    'a disabled staff member',
    (f, db) =>
      run(db, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
        f.kit.clock.now(),
        f.staff?.id ?? '',
      ]),
    409,
    'SCAN_STAFF_CHANGED',
  ],
  [
    'a changed staff role',
    (f, db) => run(db, "UPDATE scan_staff SET role='door' WHERE id=?", [f.staff?.id ?? '']),
    409,
    'SCAN_STAFF_CHANGED',
  ],
  [
    'a changed scanner configuration',
    (f, db) => run(db, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [f.scanner.id]),
    409,
    'SCAN_CONFIG_CHANGED',
  ],
  [
    'a changed event window',
    (f, db) => run(db, 'UPDATE scan_events SET closes_at=closes_at+1 WHERE id=?', [f.event.id]),
    409,
    'SCAN_CONFIG_CHANGED',
  ],
  [
    'a changed session scope',
    (f, db) =>
      run(db, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
        JSON.stringify({ templateIds: [f.template] }),
        f.sessionId,
      ]),
    409,
    'SCAN_CONFIG_CHANGED',
  ],
];

describe('scanner history denials', () => {
  it.each(Object.keys(reads) as (keyof typeof reads)[])(
    'a staffed scanner reads its own %s with the scan and its title (positive control)',
    async (name) => {
      const f = await activityFixture({ role: 'manager' });
      const response = await reads[name](f);
      expect(response.status).toBe(200);
      const body = await response.text();
      if (name === 'recent') expect(body).toContain(f.scanId ?? 'no scan');
      else expect(JSON.parse(body)).toMatchObject({ total: 1, ok: 1 });
    },
  );

  for (const [label, change, status, code] of denials)
    it.each(Object.keys(reads) as (keyof typeof reads)[])(
      `refuses %s before the page read after ${label}`,
      async (name) => {
        const f = await activityFixture({ role: 'manager' });
        const { result, fired } = await beforeBatch(
          f.kit.env,
          PAGE,
          (db) => change(f, db),
          () => reads[name](f),
        );
        expect(fired).toBe(true);
        expect(result.status).toBe(status);
        const body = await result.text();
        expect(JSON.parse(body)).toMatchObject({ code });
        expect(body).not.toContain(ACTIVITY_NAME);
        expect(body).not.toContain(f.pass.id);
      },
    );

  it('a session paused before the request keeps the receipts and drops the pass and title', async () => {
    const f = await activityFixture({ role: 'manager' });
    await run(f.kit.env.DB, "UPDATE scanning_sessions SET status='paused' WHERE id=?", [
      f.sessionId,
    ]);
    const response = await reads.recent(f);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      items: [{ scanId: f.scanId, outcome: 'ok', title: null, actionLabel: 'Scan' }],
    });
    expect(body).not.toContain(ACTIVITY_NAME);
    // A session paused after the guard captured it is a configuration change.
    const g = await activityFixture({ role: 'manager' });
    const raced = await beforeBatch(
      g.kit.env,
      PAGE,
      (db) => run(db, "UPDATE scanning_sessions SET status='paused' WHERE id=?", [g.sessionId]),
      () => reads.recent(g),
    );
    expect(raced.result.status).toBe(409);
  });

  it('a device sees its own scans only, in its own mode and org', async () => {
    const f = await activityFixture({ role: 'manager' });
    const peer = await f.kit.scanner({ eventId: f.event.id });
    const peerRecent = await f.request('/scan/scans?limit=10', peer.headers);
    expect(peerRecent.status).toBe(200);
    expect(await peerRecent.json()).toEqual({ items: [] });
    const peerSummary = await f.request('/scan/summary', peer.headers);
    expect(await peerSummary.json()).toMatchObject({ total: 0, ok: 0, byAction: [] });
    // Control: the first scanner still sees its scan.
    expect(await (await reads.recent(f)).text()).toContain(f.scanId ?? 'no scan');
  });

  it('a screen device is refused the history', async () => {
    const f = await activityFixture();
    const screen = await f.kit.scanner({ eventId: f.event.id, deviceRole: 'monitor' });
    const response = await f.request('/scan/scans?limit=10', screen.headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'SCREEN_ONLY' });
  });

  it('an authorized page that does not come back is unavailable, not an empty history', async () => {
    const f = await activityFixture({ role: 'manager' });
    const real = f.kit.env.DB;
    f.kit.env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            // The page batch is the one whose first result is the fence's `authorized`.
            return results.length === 2 &&
              (results[0]?.results[0] as { authorized?: number } | undefined)?.authorized !==
                undefined
              ? [results[0] as D1Result, undefined as never]
              : results;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      for (const read of [() => reads.recent(f), () => f.device()]) {
        const response = await read();
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'SCAN_HISTORY_UNAVAILABLE' });
      }
    } finally {
      f.kit.env.DB = real;
    }
  });
});

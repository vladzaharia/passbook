import { describe, expect, it } from 'vitest';
import { RACE_HISTORY_PAGE, tagRe } from './race-tags.ts';
import { activityFixture } from './repo-session-activity-authority-test-fixtures.ts';
import { tripsFrom } from './trips-test-support.ts';

const PAGE = tagRe(RACE_HISTORY_PAGE);
const AUTHORIZED = /AS authorized/;

/*
 * Sequential D1 round trips of the scanner's history, session and activity reads, counted from the
 * first statement of the read. A page that holds a pass adds one trip for the keyset and the
 * manifests; an empty page is one trip.
 */
describe('scanner history round trips', () => {
  it('recent is the page batch, then the manifests with the keyset', async () => {
    const f = await activityFixture({ role: 'manager' });
    const { trips } = await tripsFrom(f.kit.env, PAGE, async () => {
      expect((await f.request('/scan/scans?limit=10', f.scanner.headers)).status).toBe(200);
    });
    expect(trips).toBe(2);
  });

  it('summary is the page batch with the totals, then the manifests with the keyset', async () => {
    const f = await activityFixture({ role: 'manager' });
    const { trips } = await tripsFrom(f.kit.env, PAGE, async () => {
      expect((await f.request('/scan/summary', f.scanner.headers)).status).toBe(200);
    });
    expect(trips).toBe(2);
  });

  it('device and console activity take two trips from their page statement', async () => {
    const f = await activityFixture({ role: 'manager' });
    for (const read of [f.device, f.console]) {
      const { trips } = await tripsFrom(f.kit.env, PAGE, async () => {
        expect((await read()).status).toBe(200);
      });
      expect(trips).toBe(2);
    }
  });

  it('an empty history is one trip each', async () => {
    const f = await activityFixture({ role: 'manager', record: false });
    for (const run of [
      () => f.request('/scan/scans?limit=10', f.scanner.headers),
      () => f.request('/scan/summary', f.scanner.headers),
      f.device,
      f.console,
    ]) {
      const { trips } = await tripsFrom(f.kit.env, PAGE, async () => {
        expect((await run()).status).toBe(200);
      });
      expect(trips).toBe(1);
    }
  });

  it('the scanner session is its own batch and the workspace stats batch', async () => {
    const f = await activityFixture({ role: 'manager' });
    const { trips } = await tripsFrom(f.kit.env, AUTHORIZED, async () => {
      expect((await f.request('/scan/session', f.scanner.headers)).status).toBe(200);
    });
    expect(trips).toBe(2);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { clockedHub } from './clocked-hub-test-fixtures.ts';
import { type SessionLiveFixtures, sessionLiveFixtures } from './session-live-test-fixtures.ts';

let fixtures: SessionLiveFixtures;
beforeAll(async () => {
  fixtures = await sessionLiveFixtures();
});

async function snapshotOf(role: 'customer' | 'desk', customer: Record<string, unknown>) {
  const { kit, parent, pairedAttachment } = fixtures;
  const session = await parent(`${role} welcome`);
  const stored = await first<{ settings: string }>(
    kit.env.DB,
    'SELECT settings FROM scanning_sessions WHERE id=?',
    [session.id],
  );
  await run(kit.env.DB, 'UPDATE scanning_sessions SET settings=? WHERE id=?', [
    JSON.stringify({ ...JSON.parse(stored?.settings ?? '{}'), customer }),
    session.id,
  ]);
  const attachment = await pairedAttachment(session.id, `${role} screen`, role);
  return clockedHub(kit.ctx, kit.clock, kit.org.id, 'live').snapshot(attachment);
}

describe('live snapshot welcome', () => {
  it('sends the session welcome to a customer screen only', async () => {
    expect((await snapshotOf('customer', { welcome: 'Scan to enter' })).welcome).toBe(
      'Scan to enter',
    );
    expect((await snapshotOf('customer', {})).welcome).toBeUndefined();
    expect((await snapshotOf('desk', { welcome: 'Scan to enter' })).welcome).toBeUndefined();
  });
});

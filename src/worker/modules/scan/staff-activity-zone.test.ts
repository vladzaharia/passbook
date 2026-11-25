import { describe, expect, it } from 'vitest';
import { makeScanStaff, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createSessionStore } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { captureConsoleFeed, consoleReadAuthority } from './feed-console-page.ts';
import { readStaffActivity } from './repo-staff-activity.ts';
import { grantScanMembership, setupScanKit } from './test-kit.ts';

const PAGE = { q: '', limit: 10 } as const;

describe('staff "today" count', () => {
  it('counts the day on the org clock for scans with no scanner', async () => {
    const kit = await setupScanKit();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('The console session must resolve.');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const auth = consoleReadAuthority(
      kit.ctx,
      await captureConsoleFeed(kit.ctx, session, authority),
    );
    const staff = await makeScanStaff(kit.fx, { orgId: kit.org.id });
    // 20:00 UTC on 31 May is 13:00 in Seattle; "now" is 03:00 UTC on 1 June, still 31 May there.
    const now = Date.UTC(2026, 5, 1, 3);
    await run(
      kit.env.DB,
      `INSERT INTO scans (id, org_id, mode, actor_type, actor_id, actor_key, staff_id, idempotency_key,
         request_hash, method, state, outcome, action_kind, at)
       VALUES ('s-1', ?, 'live', 'user', 'u', 'k', ?, 'i-1', 'h', 'manual', 'done', 'ok', 'check_in', ?)`,
      [kit.org.id, staff.id, Date.UTC(2026, 4, 31, 20)],
    );
    const today = async (zone?: string) =>
      (await readStaffActivity(kit.env.DB, auth, [], now, PAGE, zone)).find(
        (r) => r.m_id === staff.id,
      )?.m_today;
    expect(await today()).toBe(1);
    expect(await today('UTC')).toBe(0);
  });
});

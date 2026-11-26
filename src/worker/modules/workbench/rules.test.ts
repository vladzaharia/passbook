import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { principalOf } from '../../platform/idempotency.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { dailyAuth } from '../auth/jobs.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const apiLevel = (orgId: string, level: string) =>
  run(
    t.kit.env.DB,
    'INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, ?, ?, 1)',
    [orgId, 'api', JSON.stringify(level)],
  );

describe('L2: a token has its own idempotency principal', () => {
  it('wb:<orgId>:<userId>, apart from the person cookie session', () => {
    const session: SessionAuth = {
      kind: 'session',
      userId: 'u1',
      sessionId: 'h',
      roles: ['user'],
      csrfSecret: '',
      amr: 'oidc',
      mode: 'test',
    };
    expect(principalOf(session)).toBe('session:u1');
    expect(principalOf({ ...session, workbench: { orgId: 'o1', subject: 'member' } })).toBe(
      'wb:o1:u1',
    );
  });
});

describe('L4: a member token keeps the org api plan level, as a key does', () => {
  it('off refuses every call; read refuses writes', async () => {
    const off = await t.member();
    await apiLevel(off.orgId, 'off');
    const a = await t.wbMint(off.browser, off.orgId);
    await expectProblem(
      await t.call('GET', '/passes', t.asClient(a.token)),
      403,
      'FEATURE_NOT_INCLUDED',
    );
    // The person in admin is not org API use.
    expect((await t.call('GET', `/passes?orgId=${off.orgId}`, off.browser)).status).toBe(200);

    const read = await t.member();
    await apiLevel(read.orgId, 'read');
    const b = await t.wbMint(read.browser, read.orgId);
    expect((await t.call('GET', '/passes', t.asClient(b.token))).status).toBe(200);
    await expectProblem(
      await t.call('POST', '/webhook-endpoints', t.asClient(b.token), {
        url: 'https://example.com/hook',
        eventTypes: ['pass.issued'],
      }),
      403,
      'FEATURE_NOT_INCLUDED',
    );
  });
});

describe('L3: the daily auth purge drops the epochs of sessions that are gone', () => {
  it('keeps a live session epoch and removes an orphan one', async () => {
    const m = await t.member();
    expect((await t.call('DELETE', `/workbench/token?orgId=${m.orgId}`, m.browser)).status).toBe(
      200,
    );
    const live = await sha256Hex(m.session.cookieValue);
    const gone = await makeSession(t.kit.f, { userId: m.user.id, roles: ['user', 'console'] });
    const goneHash = await sha256Hex(gone.cookieValue);
    await run(
      t.kit.env.DB,
      'INSERT INTO workbench_token_epochs (session_id_hash, generation, changed_at) VALUES (?, 1, ?)',
      [goneHash, t.kit.clock.now()],
    );
    await run(t.kit.env.DB, 'DELETE FROM sessions WHERE id_hash = ?', [goneHash]);
    await dailyAuth(createJobContext(t.kit.env, 'daily', { clock: t.kit.clock }));
    const epoch = (hash: string) =>
      first<{ generation: number }>(
        t.kit.env.DB,
        'SELECT generation FROM workbench_token_epochs WHERE session_id_hash = ?',
        [hash],
      );
    expect(await epoch(live)).toMatchObject({ generation: 1 });
    expect(await epoch(goneHash)).toBeNull();
  });
});

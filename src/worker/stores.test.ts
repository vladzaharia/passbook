import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../test/helpers/denial.ts';
import {
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../test/helpers/index.ts';
import { createApp } from './app.ts';
import { ManualClock } from './platform/clock.ts';
import { all, run } from './platform/db.ts';
import { createAuthStores } from './stores.ts';

describe('createAuthStores', () => {
  it('wires the D1 session and API-key stores', async () => {
    const env = await makeEnv();
    // Real clock: the stores under test read wall time for session and key expiry.
    const f = fixtures(env, new ManualClock(Date.now()));
    const stores = createAuthStores(env);
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id });
    const key = await makeApiKey(f, { scopes: ['passes:read'] });
    expect(await stores.sessions.resolve(session.cookieValue)).toMatchObject({ userId: user.id });
    expect(await stores.apiKeys.resolve(key.secret)).toMatchObject({ keyId: key.id });
    expect(await stores.sessions.resolve('unknown')).toBeNull();
    expect(await stores.apiKeys.resolve('wlt_unknown')).toBeNull();
  });

  it('audits refused principals as auth.denied, without emails or tokens', async () => {
    const env = await makeEnv();
    // Real clock: the stores under test read wall time for session and key expiry.
    const f = fixtures(env, new ManualClock(Date.now()));
    const app = createApp({ stores: createAuthStores(env) });
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id });
    const key = await makeApiKey(f, { scopes: ['passes:read'] });
    await run(env.DB, "DELETE FROM audit_log WHERE action = 'auth.denied'");
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException() {},
    };
    const send = async (path: string, init: RequestInit) => {
      const res = await app.request(`https://wallet.test${path}`, init, env, ctx as never);
      await Promise.allSettled(pending);
      return res;
    };
    const org = await makeOrg(f);
    const scoped = await makeApiKey(f, { orgId: org.id, scopes: ['passes:read'] });
    expect((await send('/api/v1/passes', { headers: scoped.headers })).status).toBe(200);
    await expectProblem(
      await send('/api/v1/users', { headers: session.headers }),
      403,
      'FORBIDDEN',
    );
    const patch = (headers: Record<string, string>) =>
      send('/api/v1/passes/p1', {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      });
    expect((await patch(scoped.headers)).status).toBe(403);
    // A Platform key's refusals are audited apart, as api_key.refused naming the key.
    expect((await patch(key.headers)).status).toBe(403);
    expect(
      (await send('/api/v1/passes', { headers: { authorization: 'Bearer wlt_unknown_key' } }))
        .status,
    ).toBe(401);
    const rows = await all<{ actor_type: string; detail: string }>(
      env.DB,
      "SELECT actor_type, detail FROM audit_log WHERE action = 'auth.denied' ORDER BY id",
    );
    expect(rows.map((r) => [r.actor_type, JSON.parse(r.detail).code])).toEqual([
      ['user', 'FORBIDDEN'],
      ['api_key', 'MISSING_SCOPE'],
    ]);
    expect(JSON.parse(rows[0]?.detail ?? '{}').route).toBe('/api/v1/users');
    const refused = await all<{ actor_id: string }>(
      env.DB,
      "SELECT actor_id FROM audit_log WHERE action = 'api_key.refused'",
    );
    expect(refused.map((r) => r.actor_id)).toEqual([key.id]);
    expect(JSON.stringify(rows)).not.toMatch(/@|wlt_/);
  });
});

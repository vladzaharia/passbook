import { describe, expect, it } from 'vitest';
import { fixtures, makeApiKey, makeEnv, makeSession, makeUser } from '../../test/helpers/index.ts';
import { ManualClock } from './platform/clock.ts';
import { createAuthStores } from './stores.ts';

describe('createAuthStores', () => {
  it('wires the D1 session and API-key stores', async () => {
    const env = await makeEnv();
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
});

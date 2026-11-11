import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { createScannerStore } from './auth-store.ts';
import {
  clock,
  consoleCall,
  cookieOf,
  create,
  env,
  pairCall,
  setupScannerFixture,
} from './scanners-split-test-fixtures.ts';

setupScannerFixture();

/** Run `change` once, just before the first multi-statement batch (the edit's grant) commits. */
function raceBeforeGrant(change: () => Promise<unknown>) {
  const real = env.DB;
  let done = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!done && statements.length > 2) {
            done = true;
            await change();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(env, { DB: db });
  return () => Object.assign(env, { DB: real });
}

describe('scanner configuration edits', () => {
  it('answers 409 when the configuration moved, keeps the device paired, and the refetch succeeds', async () => {
    const { body } = await create({ name: 'Race door' });
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const store = createScannerStore(env, clock);
    expect(await store.resolve(token, 'cookie')).not.toBeNull();
    const restore = raceBeforeGrant(() =>
      run(env.DB, "UPDATE scanners SET time_zone = 'America/Chicago' WHERE id = ?", [body.id]),
    );
    let lost: Response;
    try {
      lost = await consoleCall('PATCH', `/${body.id}`, { settings: { lookup: false } });
    } finally {
      restore();
    }
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ code: 'SCANNER_CHANGED' });
    // Configuration drift never unpairs: the same credential still resolves.
    expect(await store.resolve(token, 'cookie')).not.toBeNull();
    // The client refetches and edits again from the new state.
    expect(
      (await consoleCall('PATCH', `/${body.id}`, { settings: { lookup: false } })).status,
    ).toBe(200);
  });

  it('does not refuse an edit because a volatile column moved', async () => {
    const { body } = await create({ name: 'Volatile door' });
    const restore = raceBeforeGrant(() =>
      run(
        env.DB,
        'UPDATE scanners SET last_seen_at = 5, updated_at = updated_at + 1 WHERE id = ?',
        [body.id],
      ),
    );
    try {
      const res = await consoleCall('PATCH', `/${body.id}`, { name: 'Renamed door' });
      expect(res.status).toBe(200);
    } finally {
      restore();
    }
  });

  it('refuses a revoked scanner’s next request and a re-paired scanner’s old credential', async () => {
    const { body } = await create({ name: 'Revoke door' });
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const store = createScannerStore(env, clock);
    await consoleCall('POST', `/${body.id}/revoke`);
    await expect(store.resolve(token, 'cookie')).rejects.toMatchObject({ code: 'SCANNER_REVOKED' });
    const fresh = (await (
      await consoleCall('POST', `/${body.id}/pairing?restore=true`)
    ).json()) as {
      code: string;
    };
    const again = cookieOf(await pairCall('', fresh.code)).token;
    expect(await store.resolve(token, 'cookie')).toBeNull();
    expect((await store.resolve(again, 'cookie'))?.scannerId).toBe(body.id);
  });
});

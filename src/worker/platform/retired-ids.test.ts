import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeUser } from '../../../test/helpers/index.ts';
import { ManualClock, systemClock } from './clock.ts';
import { first, run } from './db.ts';
import type { AppEnv } from './env.ts';
import { purgeRetiredIds, RETIRED_ID_RETENTION_MS } from './retired-ids.ts';
import { createServiceContext } from './service-context.ts';

const e = env as AppEnv;
const TABLES = [
  ['retired_session_ids', 'id_hash'],
  ['retired_scanner_ids', 'id'],
  ['retired_api_key_ids', 'id'],
] as const;

describe('retired id retention', () => {
  it('purges rows past 400 days and refuses to delete younger ones', async () => {
    const ctx = createServiceContext(e, { clock: systemClock });
    const old = Date.now() - RETIRED_ID_RETENTION_MS - 1000;
    for (const [table, col] of TABLES) {
      await run(e.DB, `INSERT INTO ${table} (${col}, retired_at) VALUES (?, ?)`, ['old', old]);
      await run(e.DB, `INSERT INTO ${table} (${col}) VALUES (?)`, ['fresh']);
      await expect(run(e.DB, `DELETE FROM ${table} WHERE ${col} = 'fresh'`)).rejects.toThrow(
        'is immutable',
      );
    }
    const removed = await purgeRetiredIds(ctx);
    expect(removed).toEqual({ sessions: 1, scanners: 1, apiKeys: 1 });
    for (const [table, col] of TABLES) {
      expect(await first(e.DB, `SELECT ${col} AS id FROM ${table}`)).toEqual({ id: 'fresh' });
    }
  });

  it('a clock ahead of the database cannot purge a row inside the window', async () => {
    const ctx = createServiceContext(e, {
      clock: new ManualClock(Date.now() + 2 * RETIRED_ID_RETENTION_MS),
    });
    await run(e.DB, 'INSERT INTO retired_scanner_ids (id) VALUES (?)', ['recent']);
    await expect(purgeRetiredIds(ctx)).rejects.toThrow('is immutable');
  });

  it('keeps a deleted session id unusable until its row is purged', async () => {
    const user = await makeUser(fixtures(e, new ManualClock()));
    const id = `retire-window-${user.id}`;
    const insert = () =>
      run(
        e.DB,
        `INSERT INTO sessions (id_hash, user_id, amr, csrf_secret, created_at, last_seen_at,
           idle_expires_at, expires_at) VALUES (?, ?, 'oidc', 's', 1, 1, 2, 3)`,
        [id, user.id],
      );
    await insert();
    await run(e.DB, 'DELETE FROM sessions WHERE id_hash = ?', [id]);
    await expect(insert()).rejects.toThrow('session ID is retired');
    await purgeRetiredIds(createServiceContext(e, { clock: systemClock }));
    await expect(insert()).rejects.toThrow('session ID is retired');
  });
});

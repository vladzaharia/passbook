import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeUser } from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { dailyAuth } from './jobs.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('dailyAuth', () => {
  it('removes expired auth rows and keeps live ones', async () => {
    const e = env as AppEnv;
    const clock = new ManualClock(Date.UTC(2026, 5, 10));
    const now = clock.now();
    const user = await makeUser(fixtures(e, clock));
    const tag = Math.random().toString(36).slice(2);

    const link = (name: string, expiresAt: number) =>
      run(
        e.DB,
        `INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, 'a@example.test', 0, ?)`,
        [`${tag}-${name}`, expiresAt],
      );
    await link('old', now - 2 * DAY);
    await link('recent', now - 60_000);
    await link('live', now + 60_000);

    const flow = (name: string, expiresAt: number) =>
      run(
        e.DB,
        `INSERT INTO oidc_flows (state_hash, nonce, code_verifier, browser_binding_hash, expires_at) VALUES (?, 'n', 'v', 'b', ?)`,
        [`${tag}-${name}`, expiresAt],
      );
    await flow('old', now - 1);
    await flow('live', now + 1000);

    const session = (name: string, o: { expires: number; idle: number; revoked?: number }) =>
      run(
        e.DB,
        `INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at,
           idle_expires_at, expires_at, revoked_at) VALUES (?, ?, 'oidc', '["user"]', 'c', 0, 0, ?, ?, ?)`,
        [`${tag}-${name}`, user.id, o.idle, o.expires, o.revoked ?? null],
      );
    await session('expired', { expires: now - 2 * DAY, idle: now + DAY });
    await session('idle', { expires: now + DAY, idle: now - 2 * DAY });
    await session('revoked-old', { expires: now + DAY, idle: now + DAY, revoked: now - 8 * DAY });
    await session('revoked-new', { expires: now + DAY, idle: now + DAY, revoked: now - DAY });
    await session('live', { expires: now + DAY, idle: now + DAY });

    const counter = (name: string, start: number) =>
      run(e.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 1)', [
        `${tag}-${name}`,
        start,
      ]);
    await counter('old', now - 3 * DAY);
    await counter('today', now);

    await dailyAuth(createServiceContext(e, { clock }));

    const left = async (table: string, col: string) =>
      (
        await all<Record<string, string>>(
          e.DB,
          `SELECT ${col} AS k FROM ${table} WHERE ${col} LIKE ?`,
          [`${tag}-%`],
        )
      )
        .map((r) => (r.k ?? '').slice(tag.length + 1))
        .sort();
    expect(await left('magic_links', 'token_hash')).toEqual(['live', 'recent']);
    expect(await left('oidc_flows', 'state_hash')).toEqual(['live']);
    expect(await left('sessions', 'id_hash')).toEqual(['live', 'revoked-new']);
    expect(await left('counters', 'key')).toEqual(['today']);
  });
});

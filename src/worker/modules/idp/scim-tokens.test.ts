import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { resetScimTokenCache } from './scim-auth.ts';
import { scim, scimRig, TOKEN } from './scim-test-fixtures.ts';
import {
  activateScimToken,
  dailyScimTokens,
  hashScimToken,
  mintScimToken,
  PENDING_WINDOW_MS,
} from './scim-tokens.ts';

const status = (s: Awaited<ReturnType<typeof scimRig>>, token: string) =>
  scim(s, 'GET', '/Users', undefined, { token }).then((r) => r.status);
const stateOf = (token: string) =>
  hashScimToken(token).then((h) =>
    first<{ state: string }>(env.DB, 'SELECT state FROM idp_scim_tokens WHERE token_sha256 = ?', [
      h,
    ]),
  );

describe('SCIM receiver: D1 tokens', () => {
  it('stores only a hash, and accepts a pending token for two hours', async () => {
    const s = await scimRig();
    const { token } = await mintScimToken(s.r.ctx, 'actor-1');
    const rows = await all<Record<string, unknown>>(env.DB, 'SELECT * FROM idp_scim_tokens');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_sha256).toBe(await hashScimToken(token));
    expect(await status(s, token)).toBe(200);
    s.r.f.clock.advance(PENDING_WINDOW_MS - 1);
    expect(await status(s, token)).toBe(200);
    s.r.f.clock.advance(1);
    expect(await status(s, token)).toBe(401);
  });

  it('ignores the env secret once a D1 token is active, and falls back to it before', async () => {
    const s = await scimRig();
    expect(await status(s, TOKEN)).toBe(200);
    const { id, token } = await mintScimToken(s.r.ctx, 'actor-1');
    expect(await status(s, TOKEN)).toBe(200);
    expect(await activateScimToken(s.r.ctx, id)).toBe(true);
    s.r.f.clock.advance(6_000);
    expect(await status(s, token)).toBe(200);
    expect(await status(s, TOKEN)).toBe(401);
  });

  it('rotates without a gap and refuses the retired token', async () => {
    const s = await scimRig();
    const first = await mintScimToken(s.r.ctx, 'actor-1');
    await activateScimToken(s.r.ctx, first.id);
    s.r.f.clock.advance(6_000);
    expect(await status(s, first.token)).toBe(200);
    const next = await mintScimToken(s.r.ctx, 'actor-1');
    // Right after the mint, before the cache would expire: the new token works as pending, the old one still works.
    s.r.f.clock.advance(6_000);
    expect(await status(s, next.token)).toBe(200);
    expect(await status(s, first.token)).toBe(200);
    expect(await activateScimToken(s.r.ctx, next.id)).toBe(true);
    resetScimTokenCache();
    expect(await status(s, next.token)).toBe(200);
    expect(await status(s, first.token)).toBe(401);
    expect((await stateOf(first.token))?.state).toBe('retired');
    expect((await stateOf(next.token))?.state).toBe('active');
  });

  it('keeps one pending token: a new mint retires the older one, and a retired id cannot flip', async () => {
    const s = await scimRig();
    const a = await mintScimToken(s.r.ctx, 'actor-1');
    const b = await mintScimToken(s.r.ctx, 'actor-1');
    expect((await stateOf(a.token))?.state).toBe('retired');
    expect(await activateScimToken(s.r.ctx, a.id)).toBe(false);
    expect(await activateScimToken(s.r.ctx, b.id)).toBe(true);
  });

  it('writes last_auth_at at most once a minute', async () => {
    const s = await scimRig();
    const { id, token } = await mintScimToken(s.r.ctx, 'actor-1');
    const seen = () =>
      first<{ t: number | null }>(
        env.DB,
        'SELECT last_auth_at AS t FROM idp_scim_tokens WHERE id = ?',
        [id],
      );
    expect(await status(s, token)).toBe(200);
    const t0 = (await seen())?.t;
    expect(t0).toBe(s.r.f.clock.now());
    s.r.f.clock.advance(30_000);
    await status(s, token);
    expect((await seen())?.t).toBe(t0);
    s.r.f.clock.advance(31_000);
    await status(s, token);
    expect((await seen())?.t).toBe(s.r.f.clock.now());
  });

  it('answers 404 with no token anywhere, and 401 for a wrong token while one is live', async () => {
    const s = await scimRig();
    Object.assign(s.r.f.env, { SCIM_BEARER_TOKEN: undefined });
    expect(await status(s, 'x'.repeat(40))).toBe(404);
    const { token } = await mintScimToken(s.r.ctx, 'actor-1');
    s.r.f.clock.advance(6_000);
    expect(await status(s, 'x'.repeat(40))).toBe(401);
    expect(await status(s, token)).toBe(200);
  });

  it('never logs the token', async () => {
    const s = await scimRig();
    const { token } = await mintScimToken(s.r.ctx, 'actor-1');
    await status(s, token);
    await status(s, 'wrong-token');
    expect(JSON.stringify(s.r.logs)).not.toContain(token);
  });

  it('guards the table: no delete of a live token, no revival, no edit of the hash', async () => {
    const s = await scimRig();
    const { id } = await mintScimToken(s.r.ctx, 'actor-1');
    await expect(run(env.DB, 'DELETE FROM idp_scim_tokens WHERE id = ?', [id])).rejects.toThrow();
    await expect(
      run(env.DB, 'UPDATE idp_scim_tokens SET token_sha256 = ? WHERE id = ?', ['a'.repeat(64), id]),
    ).rejects.toThrow();
    await run(env.DB, "UPDATE idp_scim_tokens SET state = 'retired', retired_at = 1 WHERE id = ?", [
      id,
    ]);
    await expect(
      run(env.DB, "UPDATE idp_scim_tokens SET state = 'active' WHERE id = ?", [id]),
    ).rejects.toThrow();
    await expect(
      run(
        env.DB,
        "INSERT INTO idp_scim_tokens (id, state, token_sha256, created_at, created_by) VALUES ('x', 'bogus', ?, 1, 'a')",
        ['b'.repeat(64)],
      ),
    ).rejects.toThrow();
  });

  it('retention retires a stale pending token and removes retired rows after 30 days', async () => {
    const s = await scimRig();
    const a = await mintScimToken(s.r.ctx, 'actor-1');
    s.r.f.clock.advance(PENDING_WINDOW_MS + 1);
    await dailyScimTokens(s.r.ctx);
    expect((await stateOf(a.token))?.state).toBe('retired');
    s.r.f.clock.advance(29 * 86_400_000);
    await dailyScimTokens(s.r.ctx);
    expect(await stateOf(a.token)).not.toBeNull();
    s.r.f.clock.advance(2 * 86_400_000);
    await dailyScimTokens(s.r.ctx);
    expect(await stateOf(a.token)).toBeNull();
  });
});

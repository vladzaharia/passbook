import { afterEach, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { clearStatusCache, getStatus } from '../status/service.ts';
import { fakeLimiter, harness, type Jar, type TestHarness } from './test-support.ts';

const TOKEN = 'wbg_test-token-0123456789abcdefghijklmnopqrstuv';
const MINUTE = 60_000;

let h: TestHarness;
afterEach(() => h?.restore());

const enabled = async (extra: object = {}) => {
  const next = await harness({
    BREAKGLASS_TOKEN_SHA256: await sha256Hex(TOKEN),
    ...extra,
  } as object);
  // D1 state is shared across tests in a file; undo the "disabled" case.
  await run(next.env.DB, "UPDATE users SET status = 'active' WHERE name = 'Break-glass admin'");
  return next;
};

const submit = (token: string, jar: Jar = new Map(), extra: Record<string, string> = {}) =>
  h.call('/auth/breakglass', {
    method: 'POST',
    body: new URLSearchParams({ token, ...extra }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    cookies: jar,
  });

const session = async (jar: Jar) =>
  (await h.call('/api/v1/session', { cookies: jar })).json() as Promise<{
    authenticated: boolean;
    roles?: string[];
    amr?: string;
  }>;

describe('break-glass sign-in', () => {
  it('does not exist when the hash is unset or malformed', async () => {
    for (const value of [undefined, 'disabled', '']) {
      h = await harness(value === undefined ? {} : ({ BREAKGLASS_TOKEN_SHA256: value } as object));
      expect((await h.call('/auth/breakglass')).status).toBe(404);
      expect((await submit(TOKEN)).status).toBe(404);
      h.restore();
    }
  });

  it('serves a script-free form', async () => {
    h = await enabled();
    const res = await h.call('/auth/breakglass');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/auth/breakglass"');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it('refuses a wrong token without creating a session', async () => {
    h = await enabled();
    const jar: Jar = new Map();
    const res = await submit('wbg_wrong', jar);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Wrong token.');
    expect((await session(jar)).authenticated).toBe(false);
    expect(await all(h.env.DB, "SELECT 1 FROM sessions WHERE amr = 'breakglass'")).toHaveLength(0);
  });

  it('signs in as the break-glass admin with a short, audited session', async () => {
    h = await enabled();
    const jar: Jar = new Map();
    const res = await submit(TOKEN, jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const s = await session(jar);
    expect(s).toMatchObject({ authenticated: true, amr: 'breakglass' });
    expect(s.roles).toContain('admin');

    const row = await first<{ created_at: number; expires_at: number }>(
      h.env.DB,
      "SELECT created_at, expires_at FROM sessions WHERE amr = 'breakglass'",
    );
    expect(row && row.expires_at - row.created_at).toBe(4 * 60 * MINUTE);
    const audit = await all<{ detail: string }>(
      h.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'auth.sign_in'",
    );
    expect(audit.some((a) => JSON.parse(a.detail).amr === 'breakglass')).toBe(true);
  });

  it('expires after 30 idle minutes', async () => {
    h = await enabled();
    const jar: Jar = new Map();
    await submit(TOKEN, jar);
    h.clock.advance(31 * MINUTE);
    expect((await session(jar)).authenticated).toBe(false);
  });

  it('reuses one dedicated user', async () => {
    h = await enabled();
    await submit(TOKEN, new Map());
    await submit(TOKEN, new Map());
    const users = await all(h.env.DB, "SELECT id FROM users WHERE name = 'Break-glass admin'");
    expect(users).toHaveLength(1);
    const ids = await all(h.env.DB, "SELECT 1 FROM auth_identities WHERE provider = 'breakglass'");
    expect(ids).toHaveLength(1);
  });

  it('is refused once an admin disables the break-glass user', async () => {
    h = await enabled();
    await submit(TOKEN, new Map());
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE name = 'Break-glass admin'");
    const jar: Jar = new Map();
    const res = await submit(TOKEN, jar);
    expect(res.status).toBe(403);
    expect((await session(jar)).authenticated).toBe(false);
  });

  it('rejects cross-origin posts', async () => {
    h = await enabled();
    const res = await h.call('/auth/breakglass', {
      method: 'POST',
      body: new URLSearchParams({ token: TOKEN }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    });
    expect(res.status).toBe(403);
  });

  it('is rate limited per IP', async () => {
    h = await enabled({ RL_LOGIN: fakeLimiter(1) });
    expect((await submit('wbg_wrong')).status).toBe(401);
    expect((await submit(TOKEN)).status).toBe(429);
  });

  it('follows a safe next path and ignores an unsafe one', async () => {
    h = await enabled();
    const safe = await submit(TOKEN, new Map(), { next: '/admin/status' });
    expect(safe.headers.get('location')).toBe('/admin/status');
    const unsafe = await submit(TOKEN, new Map(), { next: '//evil.example' });
    expect(unsafe.headers.get('location')).toBe('/admin');
  });
});

describe('break-glass audit and status', () => {
  const failures = () =>
    all<{ ip_prefix: string | null; detail: string }>(
      h.env.DB,
      "SELECT ip_prefix, detail FROM audit_log WHERE action = 'auth.breakglass_failed'",
    );
  const component = async () => {
    const ctx = createServiceContext(h.env, { clock: h.clock });
    const status = await getStatus(ctx);
    return status.components.find((c) => c.id === 'breakglass');
  };
  const clean = async () => {
    await run(h.env.DB, "DELETE FROM audit_log WHERE action LIKE 'auth.breakglass%'");
    await run(h.env.DB, "DELETE FROM counters WHERE key LIKE '%breakglass%'");
  };

  it('audits a wrong token with the network and no token text', async () => {
    h = await enabled();
    await clean();
    const res = await h.call('/auth/breakglass', {
      method: 'POST',
      body: new URLSearchParams({ token: 'wbg_secret-guess' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': '203.0.113.5',
      },
    });
    expect(res.status).toBe(401);
    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ip_prefix).toBe('203.0.113.0/24');
    expect(rows[0]?.detail).not.toContain('wbg_secret-guess');
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ reason: 'wrong_token' });
  });

  it('stops writing rows after 100 failures in an hour', async () => {
    h = await enabled();
    await clean();
    const now = h.clock.now();
    await run(
      h.env.DB,
      "INSERT INTO counters (key, window_start, count) VALUES ('audit:breakglass_failed', ?, 100)",
      [now - (now % 3_600_000)],
    );
    expect((await submit('wbg_wrong')).status).toBe(401);
    expect(await failures()).toHaveLength(0);
    const day = await first<{ count: number }>(
      h.env.DB,
      "SELECT count FROM counters WHERE key = 'breakglass:fail'",
    );
    expect(day?.count).toBe(1);
  });

  it('audits a success as auth.breakglass_used against the break-glass user', async () => {
    h = await enabled();
    await clean();
    expect((await submit(TOKEN)).status).toBe(302);
    const rows = await all<{ target_type: string; target_id: string; ip_prefix: string | null }>(
      h.env.DB,
      "SELECT target_type, target_id, ip_prefix FROM audit_log WHERE action = 'auth.breakglass_used'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target_type).toBe('user');
    expect(rows[0]?.target_id).toBeTruthy();
  });

  it('shows in status: not configured, last use, then degraded after a failure', async () => {
    h = await harness();
    await clean();
    expect((await component())?.state).toBe('not_configured');
    h.restore();
    h = await enabled();
    clearStatusCache(h.env.DB);
    await submit(TOKEN);
    clearStatusCache(h.env.DB);
    const used = await component();
    expect(used?.state).toBe('configured');
    expect(used?.data?.lastUsedAt).toBe(h.clock.now());
    await submit('wbg_wrong');
    clearStatusCache(h.env.DB);
    expect(await component()).toMatchObject({ state: 'degraded', data: { failuresToday: 1 } });
    await clean();
  });
});

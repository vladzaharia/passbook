import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { fakeLimiter, harness, type TestHarness } from '../auth/test-support.ts';
import { type MeDeps, refreshMyPass, removeMyPass } from './service.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);

beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function setup() {
  const f1 = f();
  const user = await makeUser(f1);
  const session = await makeSession(f1, { userId: user.id });
  const org = await makeOrg(f1, { name: 'Acme' });
  const template = makeTemplate();
  const own = async (holder?: string) => {
    const pass = await makePass(f1, {
      orgId: org.id,
      template: template.resolved,
      holderEmail: holder,
    });
    await run(h.env.DB, 'UPDATE passes SET owner_user_id = ?, display_title = ? WHERE id = ?', [
      user.id,
      'My pass',
      pass.id,
    ]);
    return pass;
  };
  return { user, session, org, template, own, f1 };
}

const get = (path: string, headers: Record<string, string>) => h.call(path, { headers });
const send = (method: string, path: string, headers: Record<string, string>, json?: unknown) =>
  h.call(path, { method, headers, json });

describe('passes', () => {
  it('lists only my passes with what PassCard needs', async () => {
    const { session, own, f1, org, template, user } = await setup();
    const mine = await own();
    await run(h.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
      JSON.stringify({ description: 'Hello', organizationName: 'Acme' }),
      mine.id,
    ]);
    const stranger = await makePass(f1, { orgId: org.id, template: template.resolved });
    const otherUser = await makeUser(f1);
    await run(h.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [
      otherUser.id,
      stranger.id,
    ]);
    const res = await get('/api/v1/me/passes', session.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        id: string;
        title: string;
        orgName: string;
        passJson: Record<string, unknown>;
        downloadUrl: string;
        assetBaseUrl: string;
        status: string;
      }[];
      nextCursor: string | null;
    };
    expect(body.items.map((p) => p.id)).toEqual([mine.id]);
    expect(body.items[0]).toMatchObject({
      title: 'My pass',
      orgName: 'Acme',
      status: 'active',
      passJson: { description: 'Hello' },
      downloadUrl: `https://wallet.plrs.im/p/${mine.downloadToken}/pass.pkpass`,
      assetBaseUrl: `https://wallet.plrs.im/p/${mine.downloadToken}/assets/`,
    });
    expect(user.id).toBeTruthy();
  });

  it('pages the list', async () => {
    const { session, own } = await setup();
    const ids = [(await own()).id, (await own()).id, (await own()).id];
    const p1 = (await (await get('/api/v1/me/passes?limit=2', session.headers)).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(p1.items).toHaveLength(2);
    const p2 = (await (
      await get(`/api/v1/me/passes?limit=2&cursor=${p1.nextCursor}`, session.headers)
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((p) => p.id))).toEqual(new Set(ids));
  });

  it('hides passes that are not mine (404, not 403)', async () => {
    const { session, org, template, f1 } = await setup();
    const stranger = await makePass(f1, { orgId: org.id, template: template.resolved });
    for (const [method, path] of [
      ['GET', `/api/v1/me/passes/${stranger.id}`],
      ['POST', `/api/v1/me/passes/${stranger.id}/refresh`],
      ['DELETE', `/api/v1/me/passes/${stranger.id}`],
    ] as const) {
      expect((await send(method, path, session.headers)).status).toBe(404);
    }
  });

  it('gets one pass and falls back to an empty pass_json', async () => {
    const { session, own } = await setup();
    const mine = await own();
    const body = (await (await get(`/api/v1/me/passes/${mine.id}`, session.headers)).json()) as {
      id: string;
      passJson: object;
    };
    expect(body.id).toBe(mine.id);
    expect(body.passJson).toEqual({});
  });

  it('requires a session', async () => {
    expect((await h.call('/api/v1/me/passes')).status).toBe(401);
  });

  describe('refresh and remove (seams)', () => {
    const calls: unknown[][] = [];
    const deps: MeDeps = {
      requestRefresh: async (...args) => {
        calls.push(['refresh', args[1], args[2]]);
        return { requestedAt: 42, coalesced: false };
      },
      removePassFromUser: async (...args) => {
        calls.push(['remove', args[1], args[2]]);
      },
    };
    beforeEach(() => {
      calls.length = 0;
    });

    it('refresh calls the passes seam as the user', async () => {
      const { user, own } = await setup();
      const mine = await own();
      const ctx = createServiceContext(h.env, { clock: h.clock });
      expect(await refreshMyPass(ctx, user.id, mine.id, deps)).toEqual({
        accepted: true,
        requestedAt: 42,
      });
      expect(calls).toEqual([['refresh', mine.id, { type: 'user', id: user.id }]]);
    });

    it('refresh refuses voided passes and over-limit callers', async () => {
      const { user, own } = await setup();
      const mine = await own();
      const ctx = createServiceContext(h.env, { clock: h.clock });
      await run(h.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [mine.id]);
      await expect(refreshMyPass(ctx, user.id, mine.id, deps)).rejects.toMatchObject({
        status: 409,
      });
      await run(h.env.DB, "UPDATE passes SET status = 'active' WHERE id = ?", [mine.id]);
      const limited = createServiceContext(
        { ...h.env, RL_REFRESH: fakeLimiter(3) as unknown as RateLimit },
        { clock: h.clock },
      );
      for (let i = 0; i < 3; i++) await refreshMyPass(limited, user.id, mine.id, deps);
      await expect(refreshMyPass(limited, user.id, mine.id, deps)).rejects.toBeInstanceOf(
        RateLimitedError,
      );
      expect(calls).toHaveLength(3);
    });

    it('refresh limit is per pass', async () => {
      const { user, own } = await setup();
      const a = await own();
      const b = await own();
      const limited = createServiceContext(
        { ...h.env, RL_REFRESH: fakeLimiter(1) as unknown as RateLimit },
        { clock: h.clock },
      );
      await refreshMyPass(limited, user.id, a.id, deps);
      await refreshMyPass(limited, user.id, b.id, deps);
      await expect(refreshMyPass(limited, user.id, a.id, deps)).rejects.toBeInstanceOf(
        RateLimitedError,
      );
    });

    it('remove calls the holders seam and audits', async () => {
      const { user, own } = await setup();
      const mine = await own();
      const ctx = createServiceContext(h.env, { clock: h.clock });
      expect(await removeMyPass(ctx, user.id, mine.id, deps)).toEqual({ ok: true });
      expect(calls).toEqual([['remove', mine.id, user.id]]);
      const audit = await first(
        h.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'pass.remove_from_user' AND target_id = ?",
        [mine.id],
      );
      expect(audit).not.toBeNull();
    });

    it('both refuse a pass the user does not own', async () => {
      const { user, org, template, f1 } = await setup();
      const stranger = await makePass(f1, { orgId: org.id, template: template.resolved });
      const ctx = createServiceContext(h.env, { clock: h.clock });
      await expect(refreshMyPass(ctx, user.id, stranger.id, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(removeMyPass(ctx, user.id, stranger.id, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(calls).toHaveLength(0);
    });
  });
});

describe('emails', () => {
  it('lists emails with the primary flagged', async () => {
    const { user, session } = await setup();
    const body = (await (await get('/api/v1/me/emails', session.headers)).json()) as {
      items: { email: string; primary: boolean; verifiedVia: string }[];
    };
    expect(body.items).toEqual([
      expect.objectContaining({ email: user.primaryEmail, primary: true, verifiedVia: 'admin' }),
    ]);
  });

  it('removes a secondary email but not the primary', async () => {
    const { user, session } = await setup();
    const extra = `extra-${Math.random().toString(36).slice(2)}@example.test`;
    await run(
      h.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'magic_link', 0)",
      [extra, user.id],
    );
    const del = (email: string) =>
      send('DELETE', `/api/v1/me/emails/${encodeURIComponent(email)}`, session.headers);
    expect((await del(user.primaryEmail)).status).toBe(409);
    const ok = await del(extra);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await del(extra)).status).toBe(404);
    expect((await del('not-an-email')).status).toBe(422);
  });

  it('cannot remove an address belonging to someone else', async () => {
    const { session } = await setup();
    const other = await makeUser(f());
    const res = await send(
      'DELETE',
      `/api/v1/me/emails/${encodeURIComponent(other.primaryEmail)}`,
      session.headers,
    );
    expect(res.status).toBe(404);
    expect(
      await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [other.primaryEmail]),
    ).not.toBeNull();
  });
});

describe('sessions', () => {
  it('lists live sessions and marks the current one', async () => {
    const { user, session } = await setup();
    await makeSession(f(), { userId: user.id });
    const body = (await (await get('/api/v1/me/sessions', session.headers)).json()) as {
      items: { id: string; current: boolean }[];
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.filter((s) => s.current)).toHaveLength(1);
  });

  it('revokes another session, not someone elses', async () => {
    const { user, session } = await setup();
    const second = await makeSession(f(), { userId: user.id });
    const stranger = await makeSession(f(), { userId: (await makeUser(f())).id });
    const list = (await (await get('/api/v1/me/sessions', session.headers)).json()) as {
      items: { id: string; current: boolean }[];
    };
    const other = list.items.find((s) => !s.current)?.id ?? '';
    expect((await send('DELETE', `/api/v1/me/sessions/${other}`, session.headers)).status).toBe(
      200,
    );
    const store = createSessionStore(h.env, h.clock);
    expect(await store.resolve(second.cookieValue)).toBeNull();
    expect(await store.resolve(session.cookieValue)).not.toBeNull();
    const strangerHash = (
      await first<{ id_hash: string }>(h.env.DB, 'SELECT id_hash FROM sessions WHERE user_id = ?', [
        stranger.userId,
      ])
    )?.id_hash;
    expect(
      (await send('DELETE', `/api/v1/me/sessions/${strangerHash}`, session.headers)).status,
    ).toBe(404);
    expect(await store.resolve(stranger.cookieValue)).not.toBeNull();
  });

  it('signs out everywhere', async () => {
    const { user, session } = await setup();
    const second = await makeSession(f(), { userId: user.id });
    const res = await send('POST', '/api/v1/me/sessions/revoke-all', session.headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('__Host-wallet_sid=;');
    const store = createSessionStore(h.env, h.clock);
    expect(await store.resolve(session.cookieValue)).toBeNull();
    expect(await store.resolve(second.cookieValue)).toBeNull();
  });
});

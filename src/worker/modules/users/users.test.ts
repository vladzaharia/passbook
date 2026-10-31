import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeApiKey,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);
let n = 0;
const tag = () => `${++n}${Math.random().toString(36).slice(2, 7)}`;

beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function admin() {
  const user = await makeUser(f());
  const s = await makeSession(f(), { userId: user.id, roles: ['admin', 'user'] });
  return { user, headers: s.headers };
}

const get = (path: string, headers: Record<string, string>) => h.call(path, { headers });
const send = (method: string, path: string, headers: Record<string, string>, json?: unknown) =>
  h.call(path, { method, headers, json });

describe('access', () => {
  it('requires an admin session', async () => {
    expect((await h.call('/api/v1/users')).status).toBe(401);
    const user = await makeUser(f());
    const s = await makeSession(f(), { userId: user.id, roles: ['user'] });
    expect((await get('/api/v1/users', s.headers)).status).toBe(403);
    const key = await makeApiKey(f());
    expect((await get('/api/v1/users', key.headers)).status).toBe(401);
  });

  it('requires CSRF for writes', async () => {
    const a = await admin();
    const target = await makeUser(f());
    const res = await h.call(`/api/v1/users/${target.id}`, {
      method: 'PATCH',
      json: { status: 'disabled' },
      headers: { cookie: a.headers.cookie ?? '', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(403);
  });
});

describe('list', () => {
  it('pages newest first and filters by status', async () => {
    const a = await admin();
    const t = tag();
    const created = [];
    for (let i = 0; i < 3; i++) {
      created.push(await makeUser(f(), { primaryEmail: `list-${t}-${i}@example.test` }));
    }
    await run(h.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [created[0]?.id]);
    const page1 = (await (await get(`/api/v1/users?q=list-${t}&limit=2`, a.headers)).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await (
      await get(`/api/v1/users?q=list-${t}&limit=2&cursor=${page1.nextCursor}`, a.headers)
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((u) => u.id);
    expect(new Set(ids)).toEqual(new Set(created.map((u) => u.id)));
    const disabled = (await (
      await get(`/api/v1/users?q=list-${t}&status=disabled`, a.headers)
    ).json()) as { items: { id: string }[] };
    expect(disabled.items.map((u) => u.id)).toEqual([created[0]?.id]);
  });

  it('searches by secondary email, name and id and escapes wildcards', async () => {
    const a = await admin();
    const t = tag();
    const user = await makeUser(f());
    await run(h.env.DB, 'UPDATE users SET name = ? WHERE id = ?', [`Zed ${t}`, user.id]);
    await run(
      h.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', 0)",
      [`second-${t}@example.test`, user.id],
    );
    for (const q of [`second-${t}`, `zed ${t}`, user.id]) {
      const body = (await (
        await get(`/api/v1/users?q=${encodeURIComponent(q)}`, a.headers)
      ).json()) as {
        items: { id: string }[];
      };
      expect(body.items.map((u) => u.id)).toContain(user.id);
    }
    const wild = (await (await get('/api/v1/users?q=%25', a.headers)).json()) as {
      items: unknown[];
    };
    expect(wild.items).toHaveLength(0);
  });
});

describe('detail', () => {
  it('returns emails, identities with groups, sessions, passes and audit', async () => {
    const a = await admin();
    const f1 = f();
    const user = await makeUser(f1);
    await run(
      h.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at)
       VALUES ('pocketid', ?, ?, ?, 1, '["wallet-users"]', 0)`,
      [`s-${tag()}`, user.id, user.primaryEmail],
    );
    await makeSession(f1, { userId: user.id });
    const org = await makeOrg(f1);
    const pass = await makePass(f1, { orgId: org.id, template: makeTemplate().resolved });
    await run(h.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [user.id, pass.id]);
    await send('POST', `/api/v1/users/${user.id}/sessions/revoke`, a.headers);

    const res = await get(`/api/v1/users/${user.id}`, a.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      emails: { email: string }[];
      identities: { groups: string[]; provider: string }[];
      sessions: { revokedAt: number | null }[];
      passes: { id: string; title: string }[];
      passCount: number;
      recentAudit: { action: string }[];
    };
    expect(body.emails.map((e) => e.email)).toEqual([user.primaryEmail]);
    expect(body.identities[0]).toMatchObject({ provider: 'pocketid', groups: ['wallet-users'] });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.revokedAt).not.toBeNull();
    expect(body.passes.map((p) => p.id)).toEqual([pass.id]);
    expect(body.passCount).toBe(1);
    expect(body.recentAudit.map((x) => x.action)).toContain('user.sessions_revoke');
  });

  it('404s for unknown users', async () => {
    const a = await admin();
    expect((await get('/api/v1/users/nope', a.headers)).status).toBe(404);
  });
});

describe('disable and enable', () => {
  it('disabling revokes sessions and blocks the user', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const s = await makeSession(f(), { userId: user.id });
    const store = createSessionStore(h.env, h.clock);
    expect(await store.resolve(s.cookieValue)).not.toBeNull();
    const res = await send('PATCH', `/api/v1/users/${user.id}`, a.headers, { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('disabled');
    expect(await store.resolve(s.cookieValue)).toBeNull();
    const revoked = await first<{ revoked_at: number | null }>(
      h.env.DB,
      'SELECT revoked_at FROM sessions WHERE user_id = ?',
      [user.id],
    );
    expect(revoked?.revoked_at).not.toBeNull();
    const back = await send('PATCH', `/api/v1/users/${user.id}`, a.headers, { status: 'active' });
    expect(((await back.json()) as { status: string }).status).toBe('active');
    expect(await store.resolve(s.cookieValue)).toBeNull();
    const actions = await first<{ n: number }>(
      h.env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action IN ('user.disable','user.enable')",
      [user.id],
    );
    expect(actions?.n).toBe(2);
  });

  it('refuses to disable yourself and unknown users', async () => {
    const a = await admin();
    const self = await send('PATCH', `/api/v1/users/${a.user.id}`, a.headers, {
      status: 'disabled',
    });
    expect(self.status).toBe(409);
    expect(
      (await send('PATCH', '/api/v1/users/nope', a.headers, { status: 'disabled' })).status,
    ).toBe(404);
    expect(
      (await send('PATCH', `/api/v1/users/${a.user.id}`, a.headers, { status: 'bogus' })).status,
    ).toBe(422);
  });
});

describe('emails', () => {
  it('adds a verified email as admin', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const email = `Added-${tag()}@Example.test`;
    const res = await send('POST', `/api/v1/users/${user.id}/emails`, a.headers, { email });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { emails: { email: string; verifiedVia: string }[] };
    expect(body.emails).toContainEqual(
      expect.objectContaining({ email: email.toLowerCase(), verifiedVia: 'admin' }),
    );
    const again = await send('POST', `/api/v1/users/${user.id}/emails`, a.headers, { email });
    expect(again.status).toBe(201);
  });

  it('attaches passes waiting for an added email', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const email = `wait-${tag()}@example.test`;
    const org = await makeOrg(f());
    const pass = await makePass(f(), {
      orgId: org.id,
      template: makeTemplate().resolved,
      holderEmail: email,
    });
    await send('POST', `/api/v1/users/${user.id}/emails`, a.headers, { email });
    const row = await first<{ owner_user_id: string | null }>(
      h.env.DB,
      'SELECT owner_user_id FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.owner_user_id).toBe(user.id);
  });

  it('refuses invalid addresses and addresses owned by another user', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const other = await makeUser(f());
    expect(
      (await send('POST', `/api/v1/users/${user.id}/emails`, a.headers, { email: 'nope' })).status,
    ).toBe(422);
    const taken = await send('POST', `/api/v1/users/${user.id}/emails`, a.headers, {
      email: other.primaryEmail,
    });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe('EMAIL_TAKEN');
  });

  it('removes a secondary email but never the primary', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const extra = `extra-${tag()}@example.test`;
    await send('POST', `/api/v1/users/${user.id}/emails`, a.headers, { email: extra });
    const del = (email: string) =>
      send('DELETE', `/api/v1/users/${user.id}/emails/${encodeURIComponent(email)}`, a.headers);
    expect((await del(user.primaryEmail)).status).toBe(409);
    expect((await del(extra)).status).toBe(200);
    expect((await del(extra)).status).toBe(404);
    expect(await first(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [extra])).toBeNull();
  });
});

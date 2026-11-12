import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
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
  return { user, session: s, headers: s.headers };
}

const send = (method: string, path: string, headers: Record<string, string>, json?: unknown) =>
  h.call(path, { method, headers, json });
const actions = async (userId: string) =>
  (
    await all<{ action: string }>(
      h.env.DB,
      'SELECT action FROM audit_log WHERE target_id = ? ORDER BY id',
      [userId],
    )
  ).map((r) => r.action);

describe('sessions', () => {
  it('marks the requester session as current and labels the method', async () => {
    const a = await admin();
    const res = await send('GET', `/api/v1/users/${a.user.id}`, a.headers);
    const body = (await res.json()) as {
      sessions: { id: string; current: boolean; method: string }[];
    };
    const own = await sha256Hex(a.session.cookieValue);
    expect(body.sessions.find((s) => s.id === own)).toMatchObject({
      current: true,
      method: 'Polaris ID',
    });
  });

  it('revokes only the chosen session and audits session.revoke', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const one = await makeSession(f(), { userId: user.id, amr: 'magic_link' });
    const two = await makeSession(f(), { userId: user.id });
    const store = createSessionStore(h.env, h.clock);
    const oneId = await sha256Hex(one.cookieValue);

    const res = await send('DELETE', `/api/v1/users/${user.id}/sessions/${oneId}`, a.headers);
    expect(res.status).toBe(200);
    expect(await store.resolve(one.cookieValue)).toBeNull();
    expect(await store.resolve(two.cookieValue)).not.toBeNull();
    expect(await actions(user.id)).toContain('session.revoke');
  });

  it('404s for a session of another user and needs an admin', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const other = await makeUser(f());
    const theirs = await makeSession(f(), { userId: other.id });
    const theirId = await sha256Hex(theirs.cookieValue);
    expect(
      (await send('DELETE', `/api/v1/users/${user.id}/sessions/${theirId}`, a.headers)).status,
    ).toBe(404);
    expect(
      (await send('DELETE', `/api/v1/users/${other.id}/sessions/${theirId}`, theirs.headers))
        .status,
    ).toBe(403);
  });
});

describe('make primary', () => {
  it('moves the primary to a verified address and audits user.email_primary', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const extra = `extra-${tag()}@example.test`;
    await send('POST', `/api/v1/users/${user.id}/emails`, a.headers, { email: extra });
    const res = await send(
      'POST',
      `/api/v1/users/${user.id}/emails/${encodeURIComponent(extra)}/primary`,
      a.headers,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { primaryEmail: string }).primaryEmail).toBe(extra);
    const row = await first<{ primary_email: string }>(
      h.env.DB,
      'SELECT primary_email FROM users WHERE id = ?',
      [user.id],
    );
    expect(row?.primary_email).toBe(extra);
    expect(await actions(user.id)).toContain('user.email_primary');
  });

  it('refuses an address the user does not own', async () => {
    const a = await admin();
    const user = await makeUser(f());
    const other = await makeUser(f());
    const res = await send(
      'POST',
      `/api/v1/users/${user.id}/emails/${encodeURIComponent(other.primaryEmail)}/primary`,
      a.headers,
    );
    expect(res.status).toBe(404);
  });
});

describe('list facts', () => {
  it('returns the pass count and sign-in methods', async () => {
    const a = await admin();
    const user = await makeUser(f());
    await run(
      h.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at)
       VALUES ('pocketid', ?, ?, ?, 1, '[]', 0)`,
      [`s-${tag()}`, user.id, user.primaryEmail],
    );
    const org = await makeOrg(f());
    await makePass(f(), {
      orgId: org.id,
      template: makeTemplate().resolved,
      ownerUserId: user.id,
    });
    const res = await send('GET', `/api/v1/users?q=${user.id}`, a.headers);
    const body = (await res.json()) as {
      items: { id: string; passCount: number; signInMethods: string[] }[];
    };
    expect(body.items[0]).toMatchObject({
      id: user.id,
      passCount: 1,
      signInMethods: ['oidc', 'magic_link'],
    });
  });
});

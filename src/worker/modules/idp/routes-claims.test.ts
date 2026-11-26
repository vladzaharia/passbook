import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { createFakeIdp, type FakeIdp, installFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { fixtures, makeApiKey, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';

let h: TestHarness;
let idp: FakeIdp;
const f = () => fixtures(h.env, h.clock);
// Built from parts: a whole secret-shaped literal is what secret scanners look for.
const SECRET = ['hunter2', 'never', 'logged'].join('-');

beforeEach(async () => {
  h = await harness();
  idp = createFakeIdp();
  installFakeIdp(h.env, idp);
});
afterEach(() => h.restore());

async function person(
  roles: ('admin' | 'user')[] = ['admin', 'user'],
  amr?: 'magic_link' | 'breakglass',
) {
  const user = await makeUser(f());
  const session = await makeSession(f(), { userId: user.id, roles, ...(amr ? { amr } : {}) });
  return { user, headers: session.headers };
}
/** A user with a Polaris ID account the binding knows. */
async function target() {
  const user = await makeUser(f());
  const subject = `sub-${user.id}`;
  await run(
    h.env.DB,
    "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, 0)",
    [subject, user.id],
  );
  idp.addAccount(subject, { class: 'created' });
  return { user, subject };
}
const url = (id: string) => `/api/v1/users/${id}/claims`;
const patch = (path: string, headers: Record<string, string>, set: object) =>
  h.call(path, { method: 'PATCH', headers, json: { set } });
const text = (value: string) => ({ type: 'text', value });

describe('access', () => {
  it('is for platform admins with a recent sign-in', async () => {
    const t = await target();
    const admin = await person();
    expect((await h.call(url(t.user.id))).status).toBe(401);
    const cases = [
      [await person(['user']), 'FORBIDDEN'],
      [await person(['admin', 'user'], 'magic_link'), 'IDP_SIGN_IN_REQUIRED'],
    ] as const;
    for (const [who, code] of cases)
      await expectProblem(await h.call(url(t.user.id), { headers: who.headers }), 403, code);
    const key = await makeApiKey(f());
    expect((await h.call(url(t.user.id), { headers: key.headers })).status).toBe(401);
    expect((await h.call(url(t.user.id), { headers: admin.headers })).status).toBe(200);
    // The same rule for groups.
    expect((await h.call('/api/v1/platform/idp/groups/console/claims')).status).toBe(401);
    await expectProblem(
      await h.call('/api/v1/platform/idp/groups/console/claims', {
        headers: (await person(['user'])).headers,
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('asks an old sign-in to prove itself again', async () => {
    const t = await target();
    const user = await makeUser(f());
    const old = await makeSession(f(), {
      userId: user.id,
      roles: ['admin', 'user'],
      authTime: h.clock.now() - 3 * 3600_000,
    });
    const res = await patch(url(t.user.id), old.headers, { passbook_tier: text('gold') });
    await expectProblem(res, 403, 'STEP_UP_REQUIRED');
    expect(idp.writes).toBe(0);
  });
});

describe('user claims', () => {
  it('round trips types: text "123" stays a string', async () => {
    const t = await target();
    const { headers } = await person();
    const set = {
      passbook_code: text('123'),
      passbook_level: { type: 'number', value: 7 },
      passbook_vip: { type: 'boolean', value: true },
      passbook_meta: { type: 'json', value: { a: [1, 2] } },
    };
    const res = await patch(url(t.user.id), headers, set);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      set: Object.keys(set),
      removed: [],
      dryRun: false,
    });
    const got = await h.call(url(t.user.id), { headers });
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(await got.json()).toEqual({ claims: set, otherKeys: 0 });
    const code = (
      (await (await h.call(url(t.user.id), { headers })).json()) as {
        claims: { passbook_code: { type: string; value: unknown } };
      }
    ).claims.passbook_code;
    expect(code).toEqual({ type: 'text', value: '123' });
  });

  it('removes with null and leaves the other keys', async () => {
    const t = await target();
    const { headers } = await person();
    await patch(url(t.user.id), headers, { passbook_a: text('1'), passbook_b: text('2') });
    const res = await patch(url(t.user.id), headers, { passbook_a: null });
    expect(await res.json()).toMatchObject({ set: [], removed: ['passbook_a'] });
    const got = (await (await h.call(url(t.user.id), { headers })).json()) as {
      claims: object;
    };
    expect(Object.keys(got.claims)).toEqual(['passbook_b']);
  });

  it('refuses keys the binding does not allow, reserved keys and admin accounts', async () => {
    const t = await target();
    const { headers } = await person();
    for (const key of ['email', 'groups', 'sub', 'picture', 'other_app_key'])
      await expectProblem(
        await patch(url(t.user.id), headers, { [key]: text('x') }),
        403,
        'IDP_REFUSED',
      );
    idp.addAccount('sub-admin', { isAdmin: true });
    const adminUser = await makeUser(f());
    await run(
      h.env.DB,
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', 'sub-admin', ?, 0)",
      [adminUser.id],
    );
    await expectProblem(
      await patch(url(adminUser.id), headers, { passbook_a: text('x') }),
      403,
      'IDP_REFUSED',
    );
    expect(idp.writes).toBe(0);
  });

  it('refuses bad bodies before the binding sees them', async () => {
    const t = await target();
    const { headers } = await person();
    const bad: object[] = [
      {},
      { passbook_a: { type: 'number', value: '7' } },
      { passbook_a: { type: 'text', value: 'x'.repeat(2049) } },
      { passbook_a: { type: 'json', value: { a: { b: { c: { d: { e: { f: 1 } } } } } } } },
      { 'bad key!': text('x') },
      Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`passbook_k${i}`, text('x')])),
    ];
    for (const set of bad)
      await expectProblem(await patch(url(t.user.id), headers, set), 422, 'VALIDATION');
    expect(idp.log).not.toContain('setClaims');
  });

  it('says so when the user has no Polaris ID account', async () => {
    const { headers } = await person();
    const lone = await makeUser(f());
    await expectProblem(await h.call(url(lone.id), { headers }), 409, 'IDP_NO_ACCOUNT');
    await expectProblem(await h.call(url('missing'), { headers }), 404, 'USER_NOT_FOUND');
  });

  it('sends nothing in dry run and writes no audit row', async () => {
    idp = createFakeIdp({ mode: 'dry_run' });
    installFakeIdp(h.env, idp);
    const t = await target();
    const { headers } = await person();
    const res = await patch(url(t.user.id), headers, { passbook_a: text('x') });
    expect(await res.json()).toMatchObject({ dryRun: true });
    expect(idp.writes).toBe(0);
    expect(await audit(t.user.id)).toEqual([]);
  });
});

describe('group claims', () => {
  it('reads and writes a role group and a custom group', async () => {
    const { headers } = await person();
    await idp.createGroup('vip', 'VIP', {
      ref: 'r',
      reason: 't',
      actor: { kind: 'system', job: 't' },
    });
    for (const key of ['developer', 'vip']) {
      const path = `/api/v1/platform/idp/groups/${key}/claims`;
      const res = await patch(path, headers, { passbook_tag: text(key) });
      expect(await res.json()).toMatchObject({ set: ['passbook_tag'] });
      expect(await (await h.call(path, { headers })).json()).toEqual({
        claims: { passbook_tag: text(key) },
        otherKeys: 0,
      });
    }
    await expectProblem(
      await h.call('/api/v1/platform/idp/groups/nope/claims', { headers }),
      403,
      'IDP_REFUSED',
    );
  });
});

describe('sign-in and CSRF', () => {
  it('refuses break-glass sessions on every claims route', async () => {
    const t = await target();
    const { headers } = await person(['admin', 'user'], 'breakglass');
    const group = '/api/v1/platform/idp/groups/console/claims';
    for (const path of [url(t.user.id), group]) {
      await expectProblem(await h.call(path, { headers }), 403, 'IDP_SIGN_IN_REQUIRED');
      await expectProblem(
        await patch(path, headers, { passbook_a: text('x') }),
        403,
        'IDP_SIGN_IN_REQUIRED',
      );
    }
    expect(idp.writes).toBe(0);
    expect(idp.log).not.toContain('claims');
  });

  it('refuses a write without the CSRF token', async () => {
    const t = await target();
    const { headers } = await person();
    const res = await h.call(url(t.user.id), {
      method: 'PATCH',
      json: { set: { passbook_a: text('x') } },
      headers: { cookie: headers.cookie ?? '', 'sec-fetch-site': 'same-origin' },
    });
    await expectProblem(res, 403, 'CSRF_TOKEN');
    expect(idp.writes).toBe(0);
  });
});

describe('more cases', () => {
  it('refuses a user with several Polaris ID accounts', async () => {
    const t = await target();
    await run(
      h.env.DB,
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', 'sub-second', ?, 0)",
      [t.user.id],
    );
    const { headers } = await person();
    await expectProblem(await h.call(url(t.user.id), { headers }), 409, 'IDP_MULTIPLE_ACCOUNTS');
    await expectProblem(
      await patch(url(t.user.id), headers, { passbook_a: text('x') }),
      409,
      'IDP_MULTIPLE_ACCOUNTS',
    );
  });

  it('audits a group write against the group, key names only', async () => {
    const { headers, user } = await person();
    await patch('/api/v1/platform/idp/groups/console/claims', headers, {
      passbook_gx: text(SECRET),
    });
    const rows = await audit('console');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: user.id,
      target_type: 'idp_group',
      target_id: 'console',
    });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ set: ['passbook_gx'], removed: [] });
    expect(rows[0]?.detail).not.toContain(SECRET);
  });

  it('sends nothing for a group in dry run and writes no audit row', async () => {
    await idp.createGroup('drygroup', 'Dry', {
      ref: 'r',
      reason: 't',
      actor: { kind: 'system', job: 't' },
    });
    idp.mode = 'dry_run';
    const { headers } = await person();
    const res = await patch('/api/v1/platform/idp/groups/drygroup/claims', headers, {
      passbook_gx: text('x'),
    });
    expect(await res.json()).toMatchObject({ dryRun: true });
    expect(idp.writes).toBe(1); // the group's creation only
    expect(await audit('drygroup')).toEqual([]);
  });

  it('treats a same-value PATCH as nothing changed: no write, no audit row', async () => {
    const t = await target();
    const { headers } = await person();
    await patch(url(t.user.id), headers, { passbook_a: text('x') });
    const writes = idp.writes;
    const res = await patch(url(t.user.id), headers, { passbook_a: text('x'), passbook_b: null });
    expect(await res.json()).toEqual({ set: [], removed: [], dryRun: false });
    expect(idp.writes).toBe(writes);
    expect(await audit(t.user.id)).toHaveLength(1);
  });

  it('reports a no-op in dry run as a dry run', async () => {
    idp = createFakeIdp({ mode: 'dry_run' });
    installFakeIdp(h.env, idp);
    const t = await target();
    idp.accounts.get(t.subject)!.claims = { passbook_a: text('x') } as never;
    const { headers } = await person();
    const res = await patch(url(t.user.id), headers, { passbook_a: text('x') });
    expect(await res.json()).toEqual({ set: [], removed: [], dryRun: true });
    expect(await audit(t.user.id)).toEqual([]);
  });

  it('keeps an audit row when the write reached Polaris ID and then failed', async () => {
    const t = await target();
    const { headers } = await person();
    idp.failNext('IDP_DRIFT', 'setClaims');
    const res = await patch(url(t.user.id), headers, { passbook_a: text(SECRET) });
    await expectProblem(res, 503, 'IDP_DRIFT');
    const [row] = await audit(t.user.id);
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({
      attempted: ['passbook_a'],
      outcome: 'IDP_DRIFT',
    });
    for (const code of ['IDP_REFUSED', 'IDP_UPSTREAM']) {
      idp.failNext(code, 'setClaims');
      await patch(url(t.user.id), headers, { passbook_a: text('y') });
    }
    expect(await audit(t.user.id)).toHaveLength(1);
  });

  it('records who read whose claims, with a key count and no values', async () => {
    const t = await target();
    const { headers, user } = await person();
    await patch(url(t.user.id), headers, { passbook_a: text(SECRET), passbook_b: text('2') });
    await h.call(url(t.user.id), { headers });
    const rows = await all<{ actor_id: string; target_id: string; detail: string }>(
      h.env.DB,
      "SELECT actor_id, target_id, detail FROM audit_log WHERE action = 'idp.claims_read' AND target_id = ?",
      [t.user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: user.id });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ keys: 2 });
  });
});

describe('values stay out of records', () => {
  it('audit, logs and the ledger hold key names only', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const t = await target();
      const { headers, user } = await person();
      const res = await patch(url(t.user.id), headers, { passbook_secret: text(SECRET) });
      expect(res.status).toBe(200);
      await h.call(url(t.user.id), { headers });
      await patch(url(t.user.id), headers, { passbook_secret: text('x'.repeat(5000)) });
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')));
      expect(logged.join('\n')).not.toContain(SECRET);
      const rows = await audit(t.user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_type: 'user',
        actor_id: user.id,
        target_type: 'user',
        target_id: t.user.id,
      });
      expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({
        set: ['passbook_secret'],
        removed: [],
      });
      expect(JSON.stringify(idp.log)).not.toContain(SECRET);
      expect(JSON.stringify(await all(h.env.DB, 'SELECT detail FROM audit_log'))).not.toContain(
        SECRET,
      );
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

const audit = (targetId: string) =>
  all<{
    actor_type: string;
    actor_id: string;
    target_type: string;
    target_id: string;
    detail: string;
  }>(
    h.env.DB,
    "SELECT actor_type, actor_id, target_type, target_id, detail FROM audit_log WHERE action = 'idp.claims_set' AND target_id = ?",
    [targetId],
  );

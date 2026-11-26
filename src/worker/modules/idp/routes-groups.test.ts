import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { createFakeIdp, type FakeIdp, installFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import {
  fixtures,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';

let h: TestHarness;
let idp: FakeIdp;
const f = () => fixtures(h.env, h.clock);
const BASE = '/api/v1/platform/idp/groups';
/** D1 outlives a test and a key is never reused, so each test names its own. */
let crew = '';
/** The audit log outlives a test: count only what this test wrote. */
let auditFrom = 0;

beforeEach(async () => {
  h = await harness();
  crew = `g${f().ids.id().replaceAll('-', '')}`;
  auditFrom =
    (await all<{ id: number }>(h.env.DB, 'SELECT max(id) AS id FROM audit_log'))[0]?.id ?? 0;
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
const send = (method: string, path: string, headers: Record<string, string>, json?: object) =>
  h.call(path, { method, headers, ...(json ? { json } : {}) });
const audit = async (action: string) =>
  (
    await all(h.env.DB, 'SELECT 1 FROM audit_log WHERE id > ? AND action = ? AND target_id = ?', [
      auditFrom,
      action,
      crew,
    ])
  ).length;

describe('access', () => {
  it('reads need a platform admin and a sign-in with Polaris ID; writes also a recent one', async () => {
    const admin = await person();
    expect((await h.call(BASE)).status).toBe(401);
    await expectProblem(
      await h.call(BASE, { headers: (await person(['user'])).headers }),
      403,
      'FORBIDDEN',
    );
    expect((await h.call(BASE, { headers: (await makeApiKey(f())).headers })).status).toBe(401);
    expect((await h.call(BASE, { headers: admin.headers })).status).toBe(200);
    const link = await person(['admin', 'user'], 'magic_link');
    expect((await h.call(BASE, { headers: link.headers })).status).toBe(403);
    await expectProblem(
      await send('POST', BASE, link.headers, { key: crew, friendlyName: 'Crew' }),
      403,
      'IDP_SIGN_IN_REQUIRED',
    );
    const old = await makeSession(f(), {
      userId: admin.user.id,
      roles: ['admin', 'user'],
      authTime: h.clock.now() - 3 * 3600_000,
    });
    await expectProblem(
      await send('POST', BASE, old.headers, { key: crew, friendlyName: 'Crew' }),
      403,
      'STEP_UP_REQUIRED',
    );
    expect(idp.writes).toBe(0);
  });
});

describe('groups', () => {
  it('creates, lists, renames and deletes a custom group', async () => {
    const { headers } = await person();
    const made = await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ key: crew, dryRun: false });
    const list = (await (await h.call(BASE, { headers })).json()) as {
      items: { key: string; kind: string; friendlyName: string; rules: number; manual: number }[];
    };
    expect(list.items.find((g) => g.key === crew)).toMatchObject({
      kind: 'custom',
      friendlyName: 'Crew',
      rules: 0,
      manual: 0,
    });
    const renamed = await send('PATCH', `${BASE}/${crew}`, headers, { friendlyName: 'Crew two' });
    expect(await renamed.json()).toEqual({ key: crew, dryRun: false });
    expect(idp.groupStore.get(crew)?.friendlyName).toBe('Crew two');
    const gone = await send('DELETE', `${BASE}/${crew}`, headers);
    expect(await gone.json()).toEqual({ key: crew, dryRun: false });
    for (const action of ['idp.group_create', 'idp.group_update', 'idp.group_delete'])
      expect(await audit(action)).toBe(1);
    expect(
      (
        await all<{ deleted_at: number | null }>(
          h.env.DB,
          'SELECT deleted_at FROM idp_groups WHERE key = ?',
          [crew],
        )
      )[0]?.deleted_at,
    ).not.toBeNull();
  });

  it('answers a repeated Idempotency-Key from the first call', async () => {
    const { headers } = await person();
    const keyed = { ...headers, 'idempotency-key': `create-${crew}` };
    const body = { key: crew, friendlyName: 'Crew' };
    expect((await send('POST', BASE, keyed, body)).status).toBe(201);
    const again = await send('POST', BASE, keyed, body);
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await audit('idp.group_create')).toBe(1);
    const renameKey = { ...headers, 'idempotency-key': `rename-${crew}` };
    await send('PATCH', `${BASE}/${crew}`, renameKey, { friendlyName: 'Crew two' });
    const renamed = await send('PATCH', `${BASE}/${crew}`, renameKey, { friendlyName: 'Crew two' });
    expect(renamed.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('adopts the group an earlier attempt made in Polaris ID instead of orphaning it', async () => {
    const { headers } = await person();
    // The earlier attempt reached Polaris ID and left its intent, then failed before the group's own row.
    await run(
      h.env.DB,
      'INSERT INTO idp_group_intents (key, friendly_name, created_at) VALUES (?, ?, ?)',
      [crew, 'Crew', h.clock.now()],
    );
    await idp.createGroup(crew, 'Crew', {
      ref: 'earlier',
      reason: 'group_create',
      actor: { kind: 'user', id: 'earlier' },
    });
    const made = await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ key: crew, dryRun: false });
    const rows = await all(h.env.DB, 'SELECT 1 FROM idp_groups WHERE key = ?', [crew]);
    expect(rows).toHaveLength(1);
    expect(await all(h.env.DB, 'SELECT 1 FROM idp_group_intents WHERE key = ?', [crew])).toEqual(
      [],
    );
  });

  it('does not adopt an owner-adopted group, and a refusal leaves no intent', async () => {
    const { headers } = await person();
    await run(
      h.env.DB,
      'INSERT INTO idp_group_intents (key, friendly_name, created_at) VALUES (?, ?, ?)',
      [crew, 'Crew', h.clock.now()],
    );
    idp.groupStore.set(crew, {
      kind: 'adopted',
      name: `owner_${crew}`,
      friendlyName: 'Crew',
      otherClients: 0,
    });
    await idp.createGroup(`${crew}x`, 'Other', {
      ref: 'x',
      reason: 'group_create',
      actor: { kind: 'user', id: 'x' },
    });
    // Make the binding refuse the create for this key (the name is taken).
    idp.groupStore.set(`z${crew}`, {
      kind: 'custom',
      name: `passbook_g_${crew}`,
      friendlyName: 'T',
      otherClients: 0,
    });
    const res = await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    expect(res.status).toBe(409);
    expect(await all(h.env.DB, 'SELECT 1 FROM idp_groups WHERE key = ?', [crew])).toEqual([]);
    expect(await all(h.env.DB, 'SELECT 1 FROM idp_group_intents WHERE key = ?', [crew])).toEqual(
      [],
    );
  });

  it('does not adopt a group with the name but no intent of ours', async () => {
    const { headers } = await person();
    await idp.createGroup(crew, 'Theirs', {
      ref: 'other',
      reason: 'group_create',
      actor: { kind: 'user', id: 'other' },
    });
    await expectProblem(
      await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' }),
      409,
      'IDP_CONFLICT',
    );
  });

  it('answers 409 for a taken key or name, and 422 for a bad or reserved key', async () => {
    const { headers } = await person();
    await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    await expectProblem(
      await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' }),
      409,
      'IDP_CONFLICT',
    );
    // The name exists in Polaris ID but PassBook never recorded it.
    idp.groupStore.set('ghost', {
      kind: 'custom',
      name: 'passbook_g_ghost',
      friendlyName: 'Ghost',
      otherClients: 0,
    });
    await expectProblem(
      await send('POST', BASE, headers, { key: 'ghost', friendlyName: 'Ghost' }),
      409,
      'IDP_CONFLICT',
    );
    for (const key of ['Bad Key', 'console', 'a'])
      await expectProblem(
        await send('POST', BASE, headers, { key, friendlyName: 'Crew' }),
        422,
        'VALIDATION',
      );
  });

  it('refuses a delete with a reason: members, rules, other apps, role and adopted groups', async () => {
    const { headers } = await person();
    const org = await makeOrg(f());
    await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    await send('POST', `${BASE}/${crew}/rules`, headers, { orgId: org.id });
    await expectProblem(await send('DELETE', `${BASE}/${crew}`, headers), 409, 'IDP_IN_USE');
    const rule = (await (await h.call(`${BASE}/${crew}/rules`, { headers })).json()) as {
      items: { id: string }[];
    };
    await send('DELETE', `${BASE}/${crew}/rules/${rule.items[0]?.id}`, headers);
    const idpUser = await makeUser(f());
    idp.addAccount('sub-m', { class: 'created' });
    await run(
      h.env.DB,
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', 'sub-m', ?, 0)",
      [idpUser.id],
    );
    await send('POST', `${BASE}/${crew}/members`, headers, { userId: idpUser.id });
    await expectProblem(await send('DELETE', `${BASE}/${crew}`, headers), 409, 'IDP_IN_USE');
    const member = (await (await h.call(`${BASE}/${crew}/members`, { headers })).json()) as {
      items: { id: string }[];
    };
    await send('DELETE', `${BASE}/${crew}/members/${member.items[0]?.id}`, headers);
    // Polaris ID still shows an app other than PassBook.
    const g = idp.groupStore.get(crew);
    if (g) g.otherClients = 1;
    const wired = await send('DELETE', `${BASE}/${crew}`, headers);
    expect(wired.status).toBe(409);
    expect(await wired.json()).toMatchObject({
      code: 'IDP_IN_USE',
      detail: expect.stringMatching(/other apps/i),
    });
    expect(
      await all(h.env.DB, 'SELECT 1 FROM idp_groups WHERE key = ? AND deleted_at IS NULL', [crew]),
    ).toHaveLength(1);
    await expectProblem(await send('DELETE', `${BASE}/console`, headers), 409, 'IDP_REFUSED');
    await expectProblem(await send('DELETE', `${BASE}/nope`, headers), 404, 'GROUP_NOT_FOUND');
  });

  it('creates rules with the group and refuses a personal org or sandbox', async () => {
    const { headers } = await person();
    const org = await makeOrg(f());
    const owner = await makeUser(f());
    const personal = await makeOrg(f(), { personalUserId: owner.id });
    const sandbox = await makeOrg(f(), { kind: 'developer' });
    for (const bad of [personal, sandbox])
      await expectProblem(
        await send('POST', BASE, headers, {
          key: crew,
          friendlyName: 'Crew',
          rules: [{ orgId: bad.id }],
        }),
        409,
        'IDP_RULE_ORG_REFUSED',
      );
    expect(idp.groupStore.has(crew)).toBe(false);
    const made = await send('POST', BASE, headers, {
      key: crew,
      friendlyName: 'Crew',
      rules: [{ orgId: org.id, orgRoles: ['org_admin'] }],
    });
    expect(made.status).toBe(201);
    const rules = (await (await h.call(`${BASE}/${crew}/rules`, { headers })).json()) as {
      items: { orgId: string; orgRoles: string[] | null }[];
    };
    expect(rules.items).toMatchObject([{ orgId: org.id, orgRoles: ['org_admin'] }]);
    await expectProblem(
      await send('POST', `${BASE}/${crew}/rules`, headers, { orgId: org.id }),
      409,
      'IDP_RULE_EXISTS',
    );
    await expectProblem(
      await send('POST', `${BASE}/${crew}/rules`, headers, { orgId: personal.id }),
      409,
      'IDP_RULE_ORG_REFUSED',
    );
    await expectProblem(
      await send('POST', `${BASE}/${crew}/rules`, headers, { orgId: 'missing' }),
      404,
      'ORG_NOT_FOUND',
    );
  });

  it('sends nothing in dry run and records no group', async () => {
    idp = createFakeIdp({ mode: 'dry_run' });
    installFakeIdp(h.env, idp);
    const { headers } = await person();
    const res = await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    expect(await res.json()).toEqual({ key: crew, dryRun: true });
    expect(idp.writes).toBe(0);
    expect(await all(h.env.DB, 'SELECT 1 FROM idp_groups WHERE key = ?', [crew])).toEqual([]);
    expect(await audit('idp.group_create')).toBe(0);
  });

  it('answers IDP_UNAVAILABLE without the binding', async () => {
    const { removeFakeIdp } = await import('../../../../test/helpers/fake-idp.ts');
    removeFakeIdp(h.env);
    const { headers } = await person();
    await expectProblem(await h.call(BASE, { headers }), 503, 'IDP_UNAVAILABLE');
  });
});

describe('manual members', () => {
  async function linked(admin = false) {
    const user = await makeUser(f());
    const subject = `sub-${user.id}`;
    await run(
      h.env.DB,
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, 0)",
      [subject, user.id],
    );
    idp.addAccount(subject, { class: 'created', isAdmin: admin });
    return { user, subject };
  }

  it('adds by user or by subject, once, and removes', async () => {
    const { headers } = await person();
    await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    const a = await linked();
    const b = await linked();
    const added = await send('POST', `${BASE}/${crew}/members`, headers, { userId: a.user.id });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      subject: a.subject,
      userId: a.user.id,
      source: 'manual',
    });
    await expectProblem(
      await send('POST', `${BASE}/${crew}/members`, headers, { subject: a.subject }),
      409,
      'IDP_MEMBER_EXISTS',
    );
    const bySubject = await send('POST', `${BASE}/${crew}/members`, headers, {
      subject: b.subject,
    });
    expect(await bySubject.json()).toMatchObject({ userId: b.user.id });
    const listed = (await (await h.call(`${BASE}/${crew}/members`, { headers })).json()) as {
      items: { id: string }[];
    };
    expect(listed.items).toHaveLength(2);
    const id = listed.items[0]?.id ?? '';
    expect((await send('DELETE', `${BASE}/${crew}/members/${id}`, headers)).status).toBe(200);
    await expectProblem(
      await send('DELETE', `${BASE}/${crew}/members/${id}`, headers),
      404,
      'MEMBER_NOT_FOUND',
    );
    expect(await audit('idp.group_member')).toBe(3);
  });

  it('refuses Polaris ID admins, platform admins and users without one account', async () => {
    const { headers } = await person();
    await send('POST', BASE, headers, { key: crew, friendlyName: 'Crew' });
    const polarisAdmin = await linked(true);
    await expectProblem(
      await send('POST', `${BASE}/${crew}/members`, headers, { subject: polarisAdmin.subject }),
      409,
      'IDP_REFUSED',
    );
    const platformAdmin = await linked();
    await run(h.env.DB, 'UPDATE users SET last_roles = ? WHERE id = ?', [
      '["admin","user"]',
      platformAdmin.user.id,
    ]);
    await expectProblem(
      await send('POST', `${BASE}/${crew}/members`, headers, { userId: platformAdmin.user.id }),
      409,
      'IDP_REFUSED',
    );
    const lone = await makeUser(f());
    await expectProblem(
      await send('POST', `${BASE}/${crew}/members`, headers, { userId: lone.id }),
      409,
      'IDP_NO_ACCOUNT',
    );
    await expectProblem(
      await send('POST', `${BASE}/nope/members`, headers, { subject: 'x' }),
      404,
      'GROUP_NOT_FOUND',
    );
    await expectProblem(
      await send('POST', `${BASE}/${crew}/members`, headers, { userId: 'a', subject: 'b' }),
      422,
      'VALIDATION',
    );
  });
});

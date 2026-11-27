import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  makeApiKey,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  saveOrgSettings,
  type UserRow,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { PASS_LIST_ORG_CAP } from './list-all.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

async function join(orgId: string, user: UserRow, roles: OrgRole[] = ['pass_operator']) {
  const invitationId = kit.fx.ids.id();
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify(roles),
      kit.fx.ids.token(),
      now,
      now + 60_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, orgId, user.id, invitationId, JSON.stringify(roles), now],
  );
  return id;
}

/** A person with a console session and a fresh org per role list; passes are made by `kit.pass`. */
async function person(orgRoles: OrgRole[][]) {
  const user = await makeUser(kit.fx);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  const orgs = [];
  for (const roles of orgRoles) {
    const org = await makeOrg(kit.fx, { name: `Org ${kit.fx.ids.token(4)}` });
    orgs.push({ ...org, membershipId: await join(org.id, user, roles) });
  }
  return { user, session, orgs };
}

/** A pass by SQL, for organizations the release fixtures cannot approve in. */
const direct = async (orgId: string, mode: 'live' | 'test' = 'live') =>
  makePass(kit.fx, { orgId, template: kit.template, persist: false, mode });

type Page = {
  items: {
    id: string;
    orgId: string;
    orgName?: string;
    templateName?: string;
    timeZone?: string;
  }[];
  nextCursor: string | null;
  count?: number;
};
const list = (headers: Record<string, string>, query: string) =>
  app.request(`${ORIGIN}/api/v1/passes?${query}`, { headers }, kit.env);
const page = async (headers: Record<string, string>, query: string) => {
  const res = await list(headers, query);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};
const ids = (p: Page) => p.items.map((i) => i.id);

describe('GET /api/v1/passes?orgId=all', () => {
  it('lists the organizations the person can read, with a matching count', async () => {
    const { session, orgs } = await person([['pass_operator'], ['pass_operator']]);
    const [a, b] = orgs as [(typeof orgs)[0], (typeof orgs)[0]];
    const c = await makeOrg(kit.fx);
    const pa = await kit.pass({ orgId: a.id });
    const pb = await kit.pass({ orgId: b.id });
    const pc = await kit.pass({ orgId: c.id });
    const got = await page(session.headers, 'orgId=all&count=true');
    expect(ids(got)).toEqual([pb.id, pa.id].sort().reverse());
    expect(ids(got)).not.toContain(pc.id);
    expect(got.count).toBe(2);
    expect(got.nextCursor).toBeNull();
  });

  it('leaves out an organization where the role lacks passes:read', async () => {
    const { session, orgs } = await person([['pass_operator'], ['template_author']]);
    const [a, b] = orgs as [(typeof orgs)[0], (typeof orgs)[0]];
    const pa = await kit.pass({ orgId: a.id });
    const pb = await kit.pass({ orgId: b.id });
    const got = await page(session.headers, 'orgId=all&count=true');
    expect(ids(got)).toEqual([pa.id]);
    expect(ids(got)).not.toContain(pb.id);
    expect(got.count).toBe(1);
  });

  it('leaves out revoked, suspended and developer organizations, and separates modes', async () => {
    const { user, session, orgs } = await person([
      ['pass_operator'],
      ['pass_operator'],
      ['pass_operator'],
    ]);
    const [a, revoked, suspended] = orgs as [(typeof orgs)[0], (typeof orgs)[0], (typeof orgs)[0]];
    const dev = await makeOrg(kit.fx, { kind: 'developer' });
    await join(dev.id, user);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      revoked.membershipId,
    ]);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [suspended.id]);
    const live = await kit.pass({ orgId: a.id });
    const test = await kit.pass({ orgId: a.id, mode: 'test' });
    for (const o of [revoked, suspended]) await direct(o.id);
    await direct(dev.id, 'test');
    const got = await page(session.headers, 'orgId=all&count=true');
    expect(ids(got)).toEqual([live.id]);
    expect(got.count).toBe(1);
    const inTest = await page({ ...session.headers, 'x-passbook-mode': 'test' }, 'orgId=all');
    expect(ids(inTest)).toEqual([test.id]);
  });

  it('answers 403 alike for an organization you cannot read and one that does not exist', async () => {
    const { session, orgs } = await person([['pass_operator']]);
    const c = await makeOrg(kit.fx);
    const foreign = await list(session.headers, `orgId=all&orgIds=${c.id}`);
    const random = await list(session.headers, `orgId=all&orgIds=${kit.fx.ids.id()}`);
    await expectProblem(foreign, 403, 'ORG_FORBIDDEN');
    expect(foreign.status).toBe(random.status);
    // Everything but the per-request id is the same.
    const body = async (r: Response) => ({ ...((await r.json()) as object), requestId: '' });
    expect(await body(foreign)).toEqual(await body(random));
    const mine = await page(session.headers, `orgId=all&orgIds=${orgs[0]?.id}`);
    expect(mine.items).toEqual([]);
  });

  it('gives a foreign filter value the answer of a value that does not exist', async () => {
    const { session, orgs } = await person([['pass_operator']]);
    const own = orgs[0];
    if (!own) throw new Error('no org');
    await kit.pass({ orgId: own.id, memberName: 'Mine' });
    const c = await makeOrg(kit.fx);
    const tpl = makeTemplate({ id: `tpl-c-${kit.fx.ids.token(4)}` });
    const foreign = await makePass(kit.fx, {
      orgId: c.id,
      template: tpl.resolved,
      registry: tpl.registry,
      holderEmail: 'only-in-c@example.com',
    });
    await run(
      kit.env.DB,
      "UPDATE passes SET external_id = 'ext-only-c', display_title = 'Zorblax' WHERE id = ?",
      [foreign.id],
    );
    const importId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO pass_imports (id, org_id, mode, template_id, source_kind, source_name, state, created_by, created_at, expires_at)
       VALUES (?, ?, 'live', ?, 'file', 'x.csv', 'done', 'u', 0, 1)`,
      [importId, c.id, tpl.resolved.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO pass_import_rows (import_id, row_no, action, pass_id, state, result)
       VALUES (?, 1, 'create', ?, 'done', 'created')`,
      [importId, foreign.id],
    );
    const random = kit.fx.ids.id();
    const pairs: [string, string][] = [
      [`templateId=${tpl.resolved.id}`, `templateId=${random}`],
      [`connectionId=conn-c`, `connectionId=${random}`],
      [`importId=${importId}`, `importId=${random}`],
      ['q=Zorblax', `q=${random}`],
      ['holderEmail=only-in-c@example.com', 'holderEmail=nobody@example.com'],
      ['externalId=ext-only-c', `externalId=${random}`],
    ];
    for (const [foreignQuery, randomQuery] of pairs) {
      const f = await page(session.headers, `orgId=all&count=true&${foreignQuery}`);
      const r = await page(session.headers, `orgId=all&count=true&${randomQuery}`);
      expect(f, foreignQuery).toEqual({ items: [], nextCursor: null, count: 0 });
      expect(f, foreignQuery).toEqual(r);
    }
  });

  it('refuses match and orgIds without orgId=all with 422', async () => {
    const { session, orgs } = await person([['pass_operator']]);
    const match = encodeURIComponent(
      JSON.stringify([{ input: 'memberName', op: 'startsWith', value: 'x' }]),
    );
    await expectProblem(
      await list(session.headers, `orgId=all&match=${match}`),
      422,
      'MATCH_NEEDS_TEMPLATE',
    );
    await expectProblem(
      await list(session.headers, `orgId=${orgs[0]?.id}&orgIds=${orgs[0]?.id}`),
      422,
      'VALIDATION',
    );
  });

  it('pages three organizations with interleaved passes: every pass once, newest first', async () => {
    const { session, orgs } = await person([
      ['pass_operator'],
      ['pass_operator'],
      ['pass_operator'],
    ]);
    const made: string[] = [];
    for (let i = 0; i < 4; i++)
      for (const o of orgs) made.push((await kit.pass({ orgId: o.id })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const got: Page = await page(
        session.headers,
        `orgId=all&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...ids(got));
      cursor = got.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toEqual([...made].sort().reverse());
    expect(cursor).toBeNull();
  });

  it('refuses more than the organization cap unless orgIds narrows it', async () => {
    const { session, orgs } = await person(
      Array.from({ length: PASS_LIST_ORG_CAP + 1 }, () => ['pass_operator'] as OrgRole[]),
    );
    await expectProblem(await list(session.headers, 'orgId=all'), 422, 'ORG_SCOPE_TOO_WIDE');
    const two = `${orgs[0]?.id},${orgs[1]?.id}`;
    expect((await list(session.headers, `orgId=all&orgIds=${two}`)).status).toBe(200);
  });

  it('adds organization, template and time zone to every row, and only to lists across organizations', async () => {
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const personal = await makeOrg(kit.fx, { name: 'Stored name', personalUserId: user.id });
    const team = await makeOrg(kit.fx, { name: 'Team org' });
    await join(personal.id, user);
    await join(team.id, user);
    await saveOrgSettings(kit.env.DB, team.id, { 'org.timeZone': 'Europe/Paris' }, kit.clock.now());
    const pp = await direct(personal.id);
    const pt = await kit.pass({ orgId: team.id });
    const got = await page(session.headers, 'orgId=all');
    const row = (id: string) => got.items.find((i) => i.id === id);
    expect(row(pp.id)).toMatchObject({ orgName: 'Personal', timeZone: 'America/Los_Angeles' });
    expect(row(pt.id)).toMatchObject({ orgName: 'Team org', timeZone: 'Europe/Paris' });
    expect(row(pt.id)?.templateName).toBe('Test template');
    const single = await page(session.headers, `orgId=${team.id}`);
    for (const item of single.items) {
      expect(item).not.toHaveProperty('orgName');
      expect(item).not.toHaveProperty('templateName');
      expect(item).not.toHaveProperty('timeZone');
    }
  });

  it('serves the right callers', async () => {
    const { user, session, orgs } = await person([['pass_operator'], ['pass_operator']]);
    const [a, b] = orgs as [(typeof orgs)[0], (typeof orgs)[0]];
    const pa = await kit.pass({ orgId: a.id });
    const pb = await kit.pass({ orgId: b.id });
    const outsider = await makeOrg(kit.fx);
    const po = await kit.pass({ orgId: outsider.id });
    // An org-bound key and a Platform-flavour key are refused.
    const bound = await makeApiKey(kit.fx, { orgId: a.id, scopes: ['passes:read'] });
    await expectProblem(await list(bound.headers, 'orgId=all'), 403, 'ORG_FORBIDDEN');
    const platform = await makeApiKey(kit.fx, {
      orgId: null,
      kind: 'platform',
      scopes: ['platform:read'],
    });
    await expectProblem(await list(platform.headers, 'orgId=all'), 403, 'MISSING_SCOPE');
    // An email-link session is refused by the console guard.
    const emailLink = await makeSession(kit.fx, {
      userId: user.id,
      roles: ['user'],
      amr: 'magic_link',
    });
    expect((await list(emailLink.headers, 'orgId=all')).status).toBe(403);
    // An All-organizations key reads every organization, `null` spelling included.
    const global = await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read'] });
    for (const spelling of ['all', 'null']) {
      const got = await page(global.headers, `orgId=${spelling}&limit=200`);
      expect(ids(got)).toEqual(expect.arrayContaining([pa.id, pb.id, po.id]));
    }
    const narrowed = await page(global.headers, `orgId=all&orgIds=${a.id}&count=true`);
    expect(ids(narrowed)).toEqual([pa.id]);
    expect(narrowed.count).toBe(1);
    // A platform admin who belongs to A only gets A only, and `orgId=null` stays refused.
    const admin = await makeUser(kit.fx);
    await join(a.id, admin);
    const adminSession = await makeSession(kit.fx, { userId: admin.id, roles: ['admin', 'user'] });
    const adminPage = await page(adminSession.headers, 'orgId=all');
    expect(ids(adminPage)).toEqual([pa.id]);
    await expectProblem(await list(adminSession.headers, 'orgId=null'), 403, 'ORG_FORBIDDEN');
    expect((await page(session.headers, 'orgId=all')).items.length).toBe(2);
  });

  it('refuses a Workbench token', async () => {
    const { listPassesAcross } = await import('./list-all.ts');
    const { user, orgs } = await person([['pass_operator']]);
    await expect(
      listPassesAcross(
        kit.ctx,
        {
          kind: 'session',
          userId: user.id,
          sessionId: 's',
          roles: ['user'],
          csrfSecret: 'c',
          amr: 'oidc',
          mode: 'test',
          workbench: { orgId: orgs[0]?.id ?? '', subject: 'member' },
        },
        { mode: 'test', filter: {}, orgIds: undefined },
        { cursor: undefined, limit: 10, count: false },
      ),
    ).rejects.toMatchObject({ code: 'ORG_FORBIDDEN' });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import {
  CreatedDeveloperSandboxSchema,
  DeveloperSandboxSchema,
} from '../../../shared/contracts/developer.ts';
import { ENTITLEMENT_PRESETS, presetValues } from '../../../shared/contracts/entitlements.ts';
import { PassDetailSchema, RotateLinkResponseSchema } from '../../../shared/contracts/passes.ts';
import {
  SANDBOX_PREVIEW_ONLY_COPY,
  SANDBOX_QUOTA_COPY,
  sandboxQuota,
} from '../../../shared/copy/developer.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { dailyDeveloperSandbox, SANDBOX_IDLE_MS } from './jobs.ts';
import { checkPreviewLink } from './preview-link.ts';

const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;
/** Cloudflare's always-pass test secret: the verifier skips the hostname and action checks. */
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
let siteverify: { ok: boolean };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = TURNSTILE_TEST_SECRET;
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  siteverify = { ok: true };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: siteverify.ok });
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        // A browser sends Origin; a key call comes from a server, which does not (KEY_IN_BROWSER).
        ...(headers.cookie ? { origin: ORIGIN } : {}),
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

async function person() {
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  return { user, headers: session.headers };
}

/** A person with a sandbox: the create response, the key header and the person's session. */
async function sandboxOf() {
  const p = await person();
  const res = await send('POST', '/developer/sandbox', p.headers, { turnstileToken: 'ok' });
  expect(res.status, await res.clone().text()).toBe(201);
  const parsed = CreatedDeveloperSandboxSchema.parse(await res.json());
  if (!parsed.key) throw new Error('A new sandbox returns its key.');
  const made = { ...parsed, key: parsed.key };
  return { ...p, made, key: { authorization: `Bearer ${made.key.secret}` } };
}

describe('POST /developer/sandbox', () => {
  it('makes a developer org with its admin, a Test key and a released Quickstart ticket', async () => {
    const { user, made } = await sandboxOf();
    expect(made.previewOnly).toBe(true);
    expect(made.templateId).not.toBeNull();

    const org = await first<{ kind: string; status: string }>(
      kit.env.DB,
      'SELECT kind, status FROM orgs WHERE id = ?',
      [made.orgId],
    );
    expect(org).toEqual({ kind: 'developer', status: 'active' });
    const plan = await first<{ preset: string }>(
      kit.env.DB,
      'SELECT preset FROM org_entitlements WHERE org_id = ?',
      [made.orgId],
    );
    expect(plan?.preset).toBe('developer');
    const member = await first<{ roles: string }>(
      kit.env.DB,
      'SELECT roles FROM org_memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL',
      [made.orgId, user.id],
    );
    expect(JSON.parse(member?.roles ?? '[]')).toEqual(['org_admin']);

    // A personal key in Test: the secret is returned once and lives 30 days.
    expect(made.key.secret).toMatch(/^pbp_test_/);
    expect(made.key.mode).toBe('test');
    expect(made.key.expiresAt - kit.clock.now()).toBe(30 * DAY);
    const stored = await first<{ kind: string; mode: string; scopes: string }>(
      kit.env.DB,
      'SELECT kind, mode, scopes FROM api_keys WHERE id = ?',
      [made.key.id],
    );
    expect(stored).toMatchObject({ kind: 'personal', mode: 'test' });
    const scopes = JSON.parse(stored?.scopes ?? '[]') as string[];
    expect(scopes).toEqual(
      expect.arrayContaining(['passes:read', 'passes:write', 'templates:read']),
    );
    expect(scopes.filter((s) => s === 'api-keys:write' || s.startsWith('platform:'))).toEqual([]);

    // The template is a copy of the event ticket, released in Test.
    const head = await first<{ n: number }>(
      kit.env.DB,
      `SELECT count(*) AS n FROM template_releases
       WHERE template_id = ? AND org_id = ? AND mode = 'test' AND provider = 'apple'`,
      [made.templateId, made.orgId],
    );
    expect(head?.n).toBe(1);
    const row = await first<{ name: string }>(
      kit.env.DB,
      'SELECT name FROM templates WHERE id = ?',
      [made.templateId],
    );
    expect(row?.name).toBe('Quickstart ticket');

    const audit = await first<{ actor_id: string }>(
      kit.env.DB,
      "SELECT actor_id FROM audit_log WHERE org_id = ? AND action = 'developer_sandbox.create'",
      [made.orgId],
    );
    expect(audit?.actor_id).toBe(user.id);
  });

  it('reads back as the same sandbox, without the secret', async () => {
    const s = await sandboxOf();
    const res = await send('GET', '/developer/sandbox', s.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sandbox: unknown };
    const read = DeveloperSandboxSchema.parse(body.sandbox);
    expect(read.orgId).toBe(s.made.orgId);
    expect(read.templateId).toBe(s.made.templateId);
    expect(JSON.stringify(body)).not.toContain(s.made.key.secret);
    const none = await send('GET', '/developer/sandbox', (await person()).headers);
    expect(await none.json()).toEqual({ sandbox: null, turnstileSiteKey: expect.any(String) });
  });

  it('makes one sandbox per person: a repeat finishes it and never shows a second secret', async () => {
    const s = await sandboxOf();
    const again = await send('POST', '/developer/sandbox', s.headers, { turnstileToken: 'ok' });
    expect(again.status).toBe(201);
    const body = CreatedDeveloperSandboxSchema.parse(await again.json());
    expect(body.orgId).toBe(s.made.orgId);
    expect(body.key).toBeNull();
    expect(body.previousKey?.id).toBe(s.made.key.id);
    const n = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM developer_sandboxes WHERE user_id = ?',
      [s.user.id],
    );
    expect(n?.n).toBe(1);
    // The table holds it too: a second row for the person is refused.
    const other = await makeOrg(kit.f, { kind: 'developer' });
    await expect(
      run(
        kit.env.DB,
        'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at) VALUES (?, ?, ?, ?)',
        [kit.f.ids.id(), other.id, s.user.id, kit.clock.now()],
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('is for a signed-in person who passes Turnstile', async () => {
    const p = await person();
    siteverify.ok = false;
    try {
      await expectProblem(
        await send('POST', '/developer/sandbox', p.headers, { turnstileToken: 'bad' }),
        403,
        'TURNSTILE_FAILED',
      );
    } finally {
      siteverify.ok = true;
    }
    // No sandbox was left behind by the refusal.
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT count(*) AS n FROM developer_sandboxes WHERE user_id = ?',
          [p.user.id],
        )
      )?.n,
    ).toBe(0);
    expect((await send('POST', '/developer/sandbox', {}, { turnstileToken: 'ok' })).status).toBe(
      401,
    );
    const noCsrf = { cookie: p.headers.cookie ?? '', 'sec-fetch-site': 'cross-site' };
    expect(
      (await send('POST', '/developer/sandbox', noCsrf, { turnstileToken: 'ok' })).status,
    ).toBe(403);
  });

  it('never answers a key: a sandbox is made by a person', async () => {
    const s = await sandboxOf();
    const res = await send('POST', '/developer/sandbox', s.key, { turnstileToken: 'ok' });
    expect([401, 403]).toContain(res.status);
  });
});

describe('POST /developer/sandbox/close', () => {
  it("closes the owner's sandbox: read-only, keys revoked, closed_at set", async () => {
    const s = await sandboxOf();
    const noCsrf = { cookie: s.headers.cookie ?? '', 'sec-fetch-site': 'cross-site' };
    expect((await send('POST', '/developer/sandbox/close', noCsrf)).status).toBe(403);
    expect((await send('POST', '/developer/sandbox/close', s.key)).status).toBeGreaterThanOrEqual(
      401,
    );
    expect((await send('GET', '/passes', s.key)).status).toBe(200);

    const res = await send('POST', '/developer/sandbox/close', s.headers);
    expect(res.status, await res.clone().text()).toBe(200);
    const closed = DeveloperSandboxSchema.parse(await res.json());
    expect(closed.closedAt).toBe(kit.clock.now());
    const state = await first<{ status: string; reason: string; revoked: number }>(
      kit.env.DB,
      `SELECT o.status, d.close_reason AS reason,
        (SELECT count(*) FROM api_keys k WHERE k.org_id = o.id AND k.revoked_at IS NULL) AS revoked
       FROM orgs o JOIN developer_sandboxes d ON d.org_id = o.id WHERE o.id = ?`,
      [s.made.orgId],
    );
    expect(state).toEqual({ status: 'deleted', reason: 'user', revoked: 0 });
    expect((await send('GET', '/passes', s.key)).status).toBeGreaterThanOrEqual(401);
    // Closed for good: no second sandbox, and closing again changes nothing.
    await expectProblem(
      await send('POST', '/developer/sandbox', s.headers, { turnstileToken: 'ok' }),
      409,
      'SANDBOX_EXISTS',
    );
    const twice = await send('POST', '/developer/sandbox/close', s.headers);
    expect(twice.status).toBe(200);
    expect(DeveloperSandboxSchema.parse(await twice.json()).closedAt).toBe(closed.closedAt);
    const audit = await first<{ actor_type: string }>(
      kit.env.DB,
      "SELECT actor_type FROM audit_log WHERE org_id = ? AND action = 'developer_sandbox.close'",
      [s.made.orgId],
    );
    expect(audit?.actor_type).toBe('user');
  });

  it('is 404 for a person with no sandbox', async () => {
    expect((await send('POST', '/developer/sandbox/close', (await person()).headers)).status).toBe(
      404,
    );
  });
});

describe('a developer org never holds Live', () => {
  it('keeps its kind: the trigger refuses a change either way', async () => {
    const s = await sandboxOf();
    await expect(
      run(kit.env.DB, "UPDATE orgs SET kind = 'standard' WHERE id = ?", [s.made.orgId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(kit.env.DB, "UPDATE orgs SET kind = 'developer' WHERE id = ?", [kit.org.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses a Live key or pass row, and a session or key acting in Live, in SQL', async () => {
    const s = await sandboxOf();
    const insertKey = (mode: string) =>
      run(
        kit.env.DB,
        `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at)
         VALUES (?, ?, 'k', ?, ?, '["passes:read"]', ?, ?, ?)`,
        [
          kit.f.ids.id(),
          s.made.orgId,
          kit.f.ids.token(6),
          kit.f.ids.token(),
          mode,
          s.user.id,
          kit.clock.now(),
        ],
      );
    await expect(insertKey('live')).rejects.toThrow(/no Live key/);
    await insertKey('test');

    // The principal SQL: the same membership is a live actor in Test and not in Live.
    const { actorSql, Binds } = await import('../../platform/authority-principal.ts');
    const actorOk = async (orgId: string, userId: string, mode: 'live' | 'test') => {
      const m = await first<{ id: string; org_rev: number; user_rev: number }>(
        kit.env.DB,
        `SELECT m.id, o.access_revision AS org_rev, u.access_revision AS user_rev
         FROM org_memberships m JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ? AND m.user_id = ?`,
        [orgId, userId],
      );
      const b = new Binds(false);
      const sql = actorSql(
        {
          kind: 'membership',
          membershipId: m?.id ?? '',
          mode,
          via: 'deferred',
          userAccessRevision: m?.user_rev ?? 0,
          orgAccessRevision: m?.org_rev ?? 0,
        },
        kit.clock.now(),
        b,
      );
      const row = await first<{ actor_ok: number }>(
        kit.env.DB,
        `SELECT actor_ok FROM (${sql})`,
        b.params,
      );
      return row?.actor_ok;
    };
    expect(await actorOk(s.made.orgId, s.user.id, 'test')).toBe(1);
    expect(await actorOk(s.made.orgId, s.user.id, 'live')).toBe(0);
    // A standard org is unchanged: Live stays an actor there.
    const std = await kit.member(kit.org.id, ['org_admin']);
    expect(await actorOk(kit.org.id, std.userId, 'live')).toBe(1);
    expect(await actorOk(kit.org.id, std.userId, 'test')).toBe(1);
  });

  it('refuses a platform admin and a system job acting in Live, and every table holding per-mode rows', async () => {
    const s = await sandboxOf();
    const { actorSql, Binds } = await import('../../platform/authority-principal.ts');
    const admin = await makeUser(kit.f);
    const adminSession = await makeSession(kit.f, { userId: admin.id, roles: ['admin', 'user'] });
    const sessionIdHash = await sha256Hex(adminSession.cookieValue);
    const actorOk = async (principal: Parameters<typeof actorSql>[0]) => {
      const b = new Binds(false);
      const sql = actorSql(principal, kit.clock.now(), b);
      return (
        await first<{ actor_ok: number }>(kit.env.DB, `SELECT actor_ok FROM (${sql})`, b.params)
      )?.actor_ok;
    };
    const platform = (orgId: string, mode: 'live' | 'test') =>
      ({ kind: 'platform', userId: admin.id, sessionIdHash, orgId, mode }) as const;
    const system = (orgId: string, mode: 'live' | 'test') =>
      ({ kind: 'system', job: 'probe', orgId, mode }) as const;
    expect(await actorOk(platform(s.made.orgId, 'test'))).toBe(1);
    expect(await actorOk(platform(s.made.orgId, 'live'))).toBe(0);
    expect(await actorOk(system(s.made.orgId, 'test'))).toBe(1);
    expect(await actorOk(system(s.made.orgId, 'live'))).toBe(0);
    // A standard org is unchanged.
    expect(await actorOk(platform(kit.org.id, 'live'))).toBe(1);
    expect(await actorOk(system(kit.org.id, 'live'))).toBe(1);

    // `operations` is progress metadata (a status, step texts, an app path and ids; no tenant data) scoped by org and
    // audience, and it grants nothing: it has no Live guard.
    // Triggers: every table with an org and a mode refuses a Live row of a developer org, before any other check.
    const tables = await all<{ name: string }>(
      kit.env.DB,
      `SELECT m.name FROM sqlite_master m
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%'
         AND m.name NOT IN ('connections', 'operations')
         AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'org_id')
         AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'mode')`,
    );
    expect(tables.length).toBeGreaterThan(50);
    // SQLite fires the newest trigger first, so a table whose later migration adds its own insert checks may refuse
    // with that message; its guard trigger must still exist and the row must still be refused.
    const othersFirst = new Set(['wallet_samsung_tombstones']);
    for (const { name } of tables) {
      const guard = await all<{ name: string }>(
        kit.env.DB,
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?
           AND sql LIKE '%''live''%' AND sql LIKE '%kind = ''developer''%'`,
        [name],
      );
      expect(guard.length, `${name} guard trigger`).toBeGreaterThan(0);
      // 0229 recreated the instance insert guard, which fires before the developer one; it is lifted for this
      // table so the developer org's own Live guard is what refuses the row.
      const attempt = () =>
        run(kit.env.DB, `INSERT INTO ${name} (org_id, mode) VALUES (?, 'live')`, [s.made.orgId]);
      const insert = expect(
        name === 'wallet_provider_instances'
          ? withoutTrigger(kit.env.DB, 'wallet_provider_generation_insert_guard', attempt)
          : attempt(),
        name,
      );
      if (othersFirst.has(name)) await insert.rejects.toThrow();
      else await insert.rejects.toThrow(/Live/);
    }
  });

  it('refuses a write the owner makes in Live, and allows it in Test', async () => {
    const s = await sandboxOf();
    const mint = (mode: 'live' | 'test') =>
      send(
        'POST',
        '/api-keys',
        { ...s.headers, 'x-passbook-mode': mode },
        {
          orgId: s.made.orgId,
          name: `second ${mode}`,
          kind: 'personal',
          mode,
          scopes: ['passes:read'],
          expiresAt: kit.clock.now() + 7 * DAY,
        },
      );
    const live = await mint('live');
    await expectProblem(live, 409, 'ORG_TEST_ONLY');
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          "SELECT count(*) AS n FROM api_keys WHERE org_id = ? AND name = 'second live'",
          [s.made.orgId],
        )
      )?.n,
    ).toBe(0);
    expect((await mint('test')).status).toBe(201);
  });
});

describe('the developer preset', () => {
  it('is the registry column and belongs to developer orgs only', async () => {
    expect(ENTITLEMENT_PRESETS).toContain('developer');
    const s = await sandboxOf();
    const values = await all<{ key: string; value: string }>(
      kit.env.DB,
      'SELECT key, value FROM org_entitlement_values WHERE org_id = ?',
      [s.made.orgId],
    );
    const want = presetValues('developer');
    for (const { key, value } of values)
      expect(JSON.parse(value), key).toEqual(want[key as keyof typeof want]);
    expect(want).toMatchObject({
      'passes.test': 500,
      'passes.changesPerDay': 10,
      'passes.live': 0,
      templates: 10,
      'webhooks.endpoints': 3,
      'wallet.google': 0,
      'wallet.samsung': 0,
      print: 0,
    });
    await expect(
      run(kit.env.DB, "UPDATE org_entitlements SET preset = 'standard' WHERE org_id = ?", [
        s.made.orgId,
      ]),
    ).rejects.toThrow(/developer orgs only/);
    await expect(
      run(kit.env.DB, "UPDATE org_entitlements SET preset = 'developer' WHERE org_id = ?", [
        kit.org.id,
      ]),
    ).rejects.toThrow(/developer orgs only/);
  });

  it('is offered to a developer org and to no other', async () => {
    const s = await sandboxOf();
    const admin = kit.admin;
    const list = async (orgId: string) => {
      const res = await send('GET', `/platform/orgs/${orgId}/entitlements`, admin);
      expect(res.status).toBe(200);
      return ((await res.json()) as { presets: { preset: string }[] }).presets.map((p) => p.preset);
    };
    expect(await list(s.made.orgId)).toEqual(['developer']);
    expect(await list(kit.org.id)).not.toContain('developer');
    const create = await send('POST', '/orgs', admin, {
      slug: `x-${kit.f.ids.token(4).toLowerCase()}`,
      name: 'X',
      preset: 'developer',
    });
    expect(create.status).toBe(422);
  });
});

describe('issue and send in a sandbox', () => {
  it('keep their shapes, with the download link on the TEST preview page', async () => {
    const s = await sandboxOf();
    const detail = await send('GET', `/templates/${s.made.templateId}`, s.key);
    const sample = ((await detail.json()) as { manifest: { sample?: Record<string, unknown> } })
      .manifest.sample;
    const created = await send('POST', '/passes', s.key, {
      templateId: s.made.templateId,
      input: sample ?? {},
      holderEmail: 'holder@example.com',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const pass = PassDetailSchema.parse(await created.json());
    const token = pass.publicUrl.split('/p/')[1] ?? '';
    expect(token).not.toBe('');
    // Same shape as any org's pass; the download link is the preview page, never a package.
    const origin = new URL(pass.publicUrl).origin;
    expect(pass.downloadUrl.startsWith(`${origin}/preview/`)).toBe(true);
    expect(
      await checkPreviewLink(
        kit.env,
        pass.downloadUrl.slice(`${origin}/preview/`.length),
        kit.clock.now(),
      ),
    ).toMatchObject({ state: 'ok', passId: pass.id });
    expect(pass.downloadUrl).not.toContain('.pkpass');
    expect(pass.mode).toBe('test');

    const rotated = await send('POST', `/passes/${pass.id}/rotate-link`, s.key);
    expect(rotated.status).toBe(200);
    const links = RotateLinkResponseSchema.parse(await rotated.json());
    const next = links.publicUrl.split('/p/')[1] ?? '';
    expect(next).not.toBe(token);
    expect(
      await checkPreviewLink(
        kit.env,
        links.downloadUrl.slice(`${origin}/preview/`.length),
        kit.clock.now(),
      ),
    ).toMatchObject({ state: 'ok', passId: pass.id });

    const resent = await send('POST', `/passes/${pass.id}/resend-email`, s.key, { attach: true });
    expect(resent.status).toBe(202);
    expect(await resent.json()).toEqual({ ok: true });

    // Nothing is a package: the stored object is the pass JSON, and the file route refuses.
    const stored = await first<{ object_key: string }>(
      kit.env.DB,
      'SELECT object_key FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(stored?.object_key).toMatch(/\.preview\.json$/);
    const file = await app.request(`${ORIGIN}/p/${next}/pass.pkpass`, {}, kit.env);
    await expectProblem(file, 409, 'SANDBOX_PREVIEW_ONLY');
    const gone = await send('GET', `/passes/${pass.id}`, s.key);
    expect(gone.status).toBe(200);
  });
});

describe('sandbox limits', () => {
  it('answers SANDBOX_QUOTA at a cap, and FEATURE_LIMIT_REACHED in an org that is not a sandbox', async () => {
    const s = await sandboxOf();
    const detail = await send('GET', `/templates/${s.made.templateId}`, s.key);
    const sample = ((await detail.json()) as { manifest: { sample?: Record<string, unknown> } })
      .manifest.sample;
    const cap = (orgId: string) =>
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
         VALUES (?, 'passes.test', '1', ?)`,
        [orgId, kit.clock.now()],
      );
    await cap(s.made.orgId);
    const issue = (n: number) =>
      send('POST', '/passes', s.key, {
        templateId: s.made.templateId,
        input: sample ?? {},
        externalId: `quota-${n}`,
      });
    expect((await issue(1)).status).toBe(201);
    const refused = await issue(2);
    await expectProblem(refused, 403, 'SANDBOX_QUOTA');
    const problem = (await refused.json()) as { detail: string };
    expect(problem).toMatchObject({ feature: 'passes.test', limit: 1, used: 1 });
    expect(problem.detail).toBe(sandboxQuota('Test passes', 1, 1));
    expect(SANDBOX_QUOTA_COPY).toContain('{feature}');
    expect(SANDBOX_PREVIEW_ONLY_COPY).toMatch(/never added to a wallet/);
  });
});

describe('change runs in a sandbox', () => {
  it('starts a change, and refuses one past the daily quota', async () => {
    const s = await sandboxOf();
    const detail = await send('GET', `/templates/${s.made.templateId}`, s.key);
    const manifest = (
      (await detail.json()) as {
        manifest: { sample?: Record<string, unknown> };
      }
    ).manifest;
    const [input, value] = Object.entries(manifest.sample ?? {})[0] ?? [];
    expect(input).toBeTruthy();
    const issued = await send('POST', '/passes', s.key, {
      templateId: s.made.templateId,
      input: manifest.sample ?? {},
      externalId: 'change-1',
    });
    expect(issued.status, await issued.clone().text()).toBe(201);
    const start = (n: number) =>
      send('POST', '/broadcasts', s.key, {
        orgId: s.made.orgId,
        kind: 'change',
        send: 'draft',
        name: `Change ${n}`,
        target: { templateIds: [s.made.templateId] },
        patch: { [input as string]: { set: `${String(value)} ${n}` } },
      });
    const first = await start(1);
    expect(first.status, await first.clone().text()).toBe(201);
    await run(
      kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'passes.changesPerDay', '1', ?)`,
      [s.made.orgId, kit.clock.now()],
    );
    const refused = await start(2);
    await expectProblem(refused, 403, 'SANDBOX_QUOTA');
    expect(await refused.json()).toMatchObject({ feature: 'passes.changesPerDay', limit: 1 });
  });
});

describe('idle close', () => {
  const sweep = () =>
    dailyDeveloperSandbox({
      ...createJobContext(kit.env, 'test', { clock: kit.clock }),
      waitUntil: () => undefined,
    });
  const closedAt = async (orgId: string) =>
    first<{ status: string; closed_at: number | null; reason: string | null }>(
      kit.env.DB,
      `SELECT o.status, d.closed_at, d.close_reason AS reason
       FROM orgs o JOIN developer_sandboxes d ON d.org_id = o.id WHERE o.id = ?`,
      [orgId],
    );

  it('closes a sandbox idle for 90 days and keeps one that is used', async () => {
    const idle = await sandboxOf();
    const used = await sandboxOf();
    kit.clock.advance(SANDBOX_IDLE_MS - DAY);
    await sweep();
    expect((await closedAt(idle.made.orgId))?.status).toBe('active');

    // A key call keeps the second one open.
    await run(kit.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [
      kit.clock.now(),
      used.made.key.id,
    ]);
    kit.clock.advance(2 * DAY);
    await sweep();
    const closed = await closedAt(idle.made.orgId);
    expect(closed).toMatchObject({ status: 'deleted', reason: 'idle' });
    expect(closed?.closed_at).toBe(kit.clock.now());
    expect((await closedAt(used.made.orgId))?.status).toBe('active');

    const lifecycle = await first<{ purge_after: number }>(
      kit.env.DB,
      'SELECT purge_after FROM orgs WHERE id = ?',
      [idle.made.orgId],
    );
    expect(lifecycle?.purge_after).toBe(kit.clock.now() + 30 * DAY);
    // The key of a closed sandbox no longer opens anything, and the person cannot make another.
    const call = await send('GET', '/passes', idle.key);
    expect(call.status).toBeGreaterThanOrEqual(401);
    const fresh = (await makeSession(kit.f, { userId: idle.user.id, roles: ['user', 'developer'] }))
      .headers;
    const again = await send('POST', '/developer/sandbox', fresh, { turnstileToken: 'ok' });
    await expectProblem(again, 409, 'SANDBOX_EXISTS');
    // A second sweep changes nothing.
    await sweep();
    expect((await closedAt(idle.made.orgId))?.closed_at).toBe(closed?.closed_at);
  });

  it('sets each funnel column once and a close once', async () => {
    const s = await sandboxOf();
    const set = (col: string, v: number) =>
      run(kit.env.DB, `UPDATE developer_sandboxes SET ${col} = ? WHERE org_id = ?`, [
        v,
        s.made.orgId,
      ]);
    for (const col of [
      'quickstart_viewed_at',
      'first_call_at',
      'first_pass_at',
      'first_preview_at',
      'first_live_key_at',
    ]) {
      await set(col, 1000);
      await set(col, 1000);
      await expect(set(col, 2000), col).rejects.toThrow(/set once/);
    }
    await expect(
      run(kit.env.DB, 'DELETE FROM developer_sandboxes WHERE org_id = ?', [s.made.orgId]),
    ).rejects.toThrow(/kept/);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { originUnlessKey } from '../../../../test/helpers/browser.ts';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type OrgRow,
} from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import {
  ReviewResultSchema,
  TemplateReviewListSchema,
} from '../../../shared/contracts/template-releases.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeTemplateWrite } from './access.ts';
import { basicPackage, makePng, passJson, zipOf } from './package/fixtures.ts';
import { fakeAssets, importZip } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
const mail: { to: string; text: string }[] = [];
let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;

interface Actor {
  userId: string;
  headers: Record<string, string>;
}

async function member(orgId: string, roles: OrgRole[]): Promise<Actor> {
  const user = await makeUser(f);
  const invitationId = f.ids.id();
  const now = clock.now();
  const json = JSON.stringify(roles);
  await run(
    env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, json, f.ids.token(), now, now + 3600_000, now, user.id],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, user.id, invitationId, json, now],
  );
  const session = await makeSession(f, { userId: user.id, roles: ['user'] });
  return { userId: user.id, headers: session.headers };
}

/** A Test (or Live) service key acting as `createdBy`, with every template scope. */
async function key(
  orgId: string,
  createdBy: string,
  mode: Mode = 'test',
  without: string[] = [],
): Promise<Actor> {
  const id = f.ids.id();
  const prefix = f.ids.token(6);
  const secret = `wlt_${prefix}_${f.ids.token()}`;
  const scopes = [
    'templates:read',
    'templates:write',
    'templates:review',
    'templates:publish',
  ].filter((scope) => !without.includes(scope));
  await run(
    env.DB,
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at, kind)
     VALUES (?, ?, 'Release key', ?, ?, ?, ?, ?, ?, 'service')`,
    [
      id,
      orgId,
      prefix,
      await sha256Hex(secret),
      JSON.stringify(scopes),
      mode,
      createdBy,
      clock.now(),
    ],
  );
  return { userId: createdBy, headers: { authorization: `Bearer ${secret}` } };
}

const send = (
  path: string,
  body: unknown,
  actor: Actor,
  options: { mode?: Mode; key?: string | null; query?: string } = {},
) => {
  const idem = options.key === undefined ? f.ids.token() : options.key;
  return app.request(
    `${ORIGIN}/api/v1/templates${path}${options.query ?? ''}`,
    {
      method: 'POST',
      headers: {
        ...actor.headers,
        ...originUnlessKey(actor.headers, ORIGIN),
        ...(options.mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
        ...(idem === null ? {} : { 'idempotency-key': idem }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env,
  );
};

/** The author's grant in Test mode: a developer org refuses Live. */
async function testAuthor(orgId: string, userId: string) {
  const session = await makeSession(f, { userId });
  const resolved = await createSessionStore(env, clock).resolve(session.cookieValue);
  if (!resolved) throw new Error('The session did not resolve');
  return authorizeTemplateWrite(
    createServiceContext(env, { clock }),
    { ...resolved, mode: 'test' },
    orgId,
    'templates:author',
  );
}

async function uploaded(name: string, org: OrgRow, by: Actor, logo?: number, inTest = false) {
  const manifest = {
    schema: 1,
    name,
    inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    sample: { name: 'Alex' },
    bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
    display: { title: '{{name}}' },
  };
  const result = await importZip(env, clock, {
    orgId: org.id,
    createdBy: by.userId,
    name,
    ...(inTest ? { authority: await testAuthor(org.id, by.userId) } : {}),
    zip: zipOf(
      basicPackage(
        {
          'wallet.template.json': JSON.stringify(manifest),
          ...(logo ? { 'logo.png': makePng(logo, 40) } : {}),
        },
        passJson(),
      ),
    ),
  });
  if (!result.result) throw new Error('Import failed');
  return result.result;
}

const _heads = (templateId: string) =>
  all<{ mode: string; version: string; generation: number }>(
    env.DB,
    `SELECT mode, version, generation FROM template_releases WHERE template_id = ?
     ORDER BY mode, generation`,
    [templateId],
  );
const _approvals = (templateId: string) =>
  all<{ mode: string; kind: string }>(
    env.DB,
    `SELECT c.mode AS mode, a.kind AS kind FROM template_approvals a
     JOIN template_candidates c ON c.id = a.candidate_id WHERE c.template_id = ? ORDER BY c.mode`,
    [templateId],
  );
const _candidates = async (templateId: string) =>
  (
    await all<{ id: string }>(env.DB, 'SELECT id FROM template_candidates WHERE template_id = ?', [
      templateId,
    ])
  ).length;

beforeAll(async () => {
  clock = new ManualClock();
  env = await makeEnv({
    PUBLIC_BASE_URL: ORIGIN,
    EMAIL_FROM: 'passes@example.test',
    EMAIL: {
      send: async (message: { to: string; text: string }) => {
        mail.push(message);
        return { messageId: 'test-message' };
      },
    } as unknown as AppEnv['EMAIL'],
    ASSETS: fakeAssets(),
    CF_VERSION: { id: 'default-worker', tag: '', timestamp: '9990-01-01T00:00:00Z' },
  });
  f = fixtures(env, clock);
  app = createApp({
    stores: {
      ...auth.stores,
      sessions: createSessionStore(env, clock),
      apiKeys: createApiKeyStore(env, clock),
    },
    clock,
  });
});

async function ok(res: Response) {
  expect(res.status, await res.clone().text()).toBe(200);
  return ReviewResultSchema.parse(await res.json());
}

const request = (id: string, org: OrgRow, version: string, by: Actor) =>
  send(`/${id}/review-requests`, { orgId: org.id, version }, by);

const inbox = async (org: OrgRow, by: Actor) => {
  const res = await app.request(
    `${ORIGIN}/api/v1/template-reviews?orgId=${org.id}`,
    { headers: { ...by.headers, ...originUnlessKey(by.headers, ORIGIN) } },
    env,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return TemplateReviewListSchema.parse(await res.json()).items;
};

const approvals = (templateId: string) =>
  all<{ id: string }>(
    env.DB,
    `SELECT a.id FROM template_approvals a JOIN template_candidates c ON c.id = a.candidate_id
     WHERE c.template_id = ?`,
    [templateId],
  );
const heads = (templateId: string) =>
  all<{ mode: string; version: string; generation: number }>(
    env.DB,
    'SELECT mode, version, generation FROM template_releases WHERE template_id = ? ORDER BY mode',
    [templateId],
  );

const emailOf = async (userId: string) =>
  (
    await all<{ e: string }>(env.DB, 'SELECT primary_email AS e FROM users WHERE id = ?', [userId])
  )[0]?.e;

describe('review requests', () => {
  it('mails the other reviewers, audits the request and lists it for them only', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Inbox Flow', org, owner);
    mail.length = 0;
    await send(`/${t.templateId}/review-requests`, { orgId: org.id, version: t.version }, owner);
    expect(mail.map((m) => m.to)).toContain(await emailOf(reviewer.userId));
    expect(mail.map((m) => m.to)).not.toContain(await emailOf(owner.userId));
    expect(mail[0]?.text).toContain('Inbox Flow');
    const audited = await all<{ action: string }>(
      env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'template.review_requested'",
      [t.templateId],
    );
    expect(audited).toHaveLength(1);
    // A repeated request creates nothing, so it mails nobody and writes no second audit row.
    mail.length = 0;
    await send(`/${t.templateId}/review-requests`, { orgId: org.id, version: t.version }, owner);
    expect(mail).toEqual([]);
    expect(
      await all(
        env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'template.review_requested'",
        [t.templateId],
      ),
    ).toHaveLength(1);
    expect(await inbox(org, reviewer)).toEqual([
      expect.objectContaining({ templateId: t.templateId, version: t.version, orgId: org.id }),
    ]);
    expect(await inbox(org, owner)).toEqual([]);
  });

  it('hides a request once a newer version exists', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Superseded Flow', org, owner);
    await request(t.templateId, org, t.version, owner);
    expect(await inbox(org, reviewer)).toHaveLength(1);
    await run(
      env.DB,
      `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_by, created_at)
       SELECT template_id, 'newer', manifest, pass_json, assets, report, created_by, created_at + 1000
       FROM template_versions WHERE template_id = ? AND version = ?`,
      [t.templateId, t.version],
    );
    expect(await inbox(org, reviewer)).toEqual([]);
  });
});

describe('templates list', () => {
  const openFlag = async (org: OrgRow, templateId: string, by: Actor) => {
    const res = await app.request(
      `${ORIGIN}/api/v1/templates?orgId=${org.id}`,
      { headers: { ...by.headers, ...originUnlessKey(by.headers, ORIGIN) } },
      env,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { items: { id: string; openReview: boolean }[] };
    return body.items.find((i) => i.id === templateId)?.openReview;
  };

  it('flags openReview while a review is waiting, and clears it once a peer approves', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Flag Flow', org, owner);
    expect(await openFlag(org, t.templateId, owner)).toBe(false);
    await request(t.templateId, org, t.version, owner);
    expect(await openFlag(org, t.templateId, owner)).toBe(true);
    await ok(
      await send(`/${t.templateId}/review`, { orgId: org.id, version: t.version }, reviewer),
    );
    expect(await openFlag(org, t.templateId, owner)).toBe(false);
  });
});

describe('review', () => {
  it('approves both modes as a peer and releases when asked', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer', 'template_publisher']);
    const t = await uploaded('Review Flow', org, owner);
    await request(t.templateId, org, t.version, owner);
    await expectProblem(
      await send(`/${t.templateId}/review`, { orgId: org.id, version: t.version }, owner),
      403,
      'TEMPLATE_SELF_APPROVAL',
    );
    const result = await ok(
      await send(
        `/${t.templateId}/review`,
        { orgId: org.id, version: t.version, release: true, note: 'Looks right.' },
        reviewer,
      ),
    );
    expect(result.approved).toEqual(['test', 'live']);
    expect(result.release?.modes).toMatchObject({
      test: { outcome: 'released', approvalKind: 'peer' },
      live: { outcome: 'released', approvalKind: 'peer' },
    });
    const audited = await all<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'template.review'",
      [t.templateId],
    );
    expect(JSON.parse(audited[0]?.detail ?? '{}')).toMatchObject({ note: 'Looks right.' });
    expect(await inbox(org, reviewer)).toEqual([]);
  });

  it('lets the only member of a sandbox review their own request, marked Self-approved', async () => {
    const org = await makeOrg(f, { kind: 'developer' });
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Sandbox Review', org, owner, undefined, true);
    const asked = await send(
      `/${t.templateId}/review-requests`,
      { orgId: org.id, version: t.version },
      owner,
      { mode: 'test' },
    );
    expect(asked.status).toBe(200);
    const result = await ok(
      await send(
        `/${t.templateId}/review`,
        { orgId: org.id, version: t.version, release: true },
        owner,
        { mode: 'test' },
      ),
    );
    expect(result.approved).toEqual(['test']);
    expect(result.release?.modes).toMatchObject({
      test: { outcome: 'released', approvalKind: 'test' },
    });
    expect(await _approvals(t.templateId)).toEqual([{ mode: 'test', kind: 'test' }]);
    await expectProblem(
      await send(
        `/${t.templateId}/review`,
        { orgId: org.id, version: t.version },
        await member(org.id, ['template_reviewer']),
        { mode: 'test' },
      ),
      404,
      'TEMPLATE_REVIEW_NOT_FOUND',
    );
  });

  it('records the version and its number on each release audit row', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer', 'template_publisher']);
    const t = await uploaded('Audit Version', org, owner);
    await request(t.templateId, org, t.version, owner);
    await ok(
      await send(
        `/${t.templateId}/review`,
        { orgId: org.id, version: t.version, release: true },
        reviewer,
      ),
    );
    const rows = await all<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'template.release'",
      [t.templateId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(JSON.parse(row.detail)).toMatchObject({ version: t.version, versionNumber: 1 });
  });

  it('refuses a version nobody asked to review', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Unasked Flow', org, owner);
    await expectProblem(
      await send(`/${t.templateId}/review`, { orgId: org.id, version: t.version }, reviewer),
      404,
      'TEMPLATE_REVIEW_NOT_FOUND',
    );
  });

  it('lets a Test key approve Test only and keeps Live keys out', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Key Review Flow', org, owner);
    await request(t.templateId, org, t.version, owner);
    const body = { version: t.version };
    await expectProblem(
      await send(`/${t.templateId}/review`, body, await key(org.id, reviewer.userId, 'live')),
      403,
      'KEY_TEST_ONLY',
    );
    const result = await ok(
      await send(`/${t.templateId}/review`, body, await key(org.id, reviewer.userId)),
    );
    expect(result.approved).toEqual(['test']);
    expect(await inbox(org, reviewer)).toHaveLength(1);
  });

  it('releases with release:true when the key also holds publish, and refuses it before approving when not', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer', 'template_publisher']);
    const t = await uploaded('Key Release Flow', org, owner);
    await request(t.templateId, org, t.version, owner);
    const body = { version: t.version, release: true };
    await expectProblem(
      await send(
        `/${t.templateId}/review`,
        body,
        await key(org.id, reviewer.userId, 'test', ['templates:publish']),
      ),
      403,
      'MISSING_SCOPE',
    );
    expect(await approvals(t.templateId)).toEqual([]);
    const result = await ok(
      await send(`/${t.templateId}/review`, body, await key(org.id, reviewer.userId)),
    );
    expect(result.approved).toEqual(['test']);
    expect(result.release?.modes.test).toMatchObject({ outcome: 'released', approvalKind: 'peer' });
    expect(await heads(t.templateId)).toEqual([
      { mode: 'test', version: t.version, generation: 1 },
    ]);
  });

  it('refuses release:true for a key without write scope before approving', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer', 'template_publisher']);
    const t = await uploaded('No Write Flow', org, owner);
    await request(t.templateId, org, t.version, owner);
    await expectProblem(
      await send(
        `/${t.templateId}/review`,
        { version: t.version, release: true },
        await key(org.id, reviewer.userId, 'test', ['templates:write']),
      ),
      403,
      'MISSING_SCOPE',
    );
    expect(await approvals(t.templateId)).toEqual([]);
  });

  it('audits only what the caller approved and refuses a replaced version', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Replaced Flow', org, owner);
    await request(t.templateId, org, t.version, owner);
    await ok(
      await send(`/${t.templateId}/review`, { orgId: org.id, version: t.version }, reviewer),
    );
    // The author reviews after a peer did: nothing new is approved or audited as a review.
    const again = await ok(
      await send(`/${t.templateId}/review`, { orgId: org.id, version: t.version }, owner),
    );
    expect(again.approved).toEqual([]);
    const reviews = await all(
      env.DB,
      "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'template.review'",
      [t.templateId],
    );
    expect(reviews).toHaveLength(1);

    await run(
      env.DB,
      `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_by, created_at)
       SELECT template_id, 'newer', manifest, pass_json, assets, report, created_by, created_at + 1000
       FROM template_versions WHERE template_id = ? AND version = ?`,
      [t.templateId, t.version],
    );
    await request(t.templateId, org, 'newer', owner);
    await expectProblem(
      await send(`/${t.templateId}/review`, { orgId: org.id, version: t.version }, reviewer),
      409,
      'TEMPLATE_REVIEW_SUPERSEDED',
    );
  });

  it("keeps a key's inbox to Test and leaves out its creator's own work", async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Key Inbox Flow', org, owner);
    await request(t.templateId, org, t.version, owner);
    expect(await inbox(org, await key(org.id, owner.userId))).toEqual([]);
    expect(await inbox(org, await key(org.id, reviewer.userId))).toHaveLength(1);
  });
});

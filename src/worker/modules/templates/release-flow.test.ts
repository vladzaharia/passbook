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
  type ReleasePlan,
  ReleasePlanSchema,
  ReleaseResultSchema,
  TemplateCandidateSchema,
} from '../../../shared/contracts/template-releases.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
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

const release = (id: string, org: OrgRow, version: string, by: Actor, extra: object = {}) =>
  send(`/${id}/release`, { orgId: org.id, version, ...extra }, by);

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

const heads = (templateId: string) =>
  all<{ mode: string; version: string; generation: number }>(
    env.DB,
    `SELECT mode, version, generation FROM template_releases WHERE template_id = ?
     ORDER BY mode, generation`,
    [templateId],
  );
const approvals = (templateId: string) =>
  all<{ mode: string; kind: string }>(
    env.DB,
    `SELECT c.mode AS mode, a.kind AS kind FROM template_approvals a
     JOIN template_candidates c ON c.id = a.candidate_id WHERE c.template_id = ? ORDER BY c.mode`,
    [templateId],
  );
const candidates = async (templateId: string) =>
  (
    await all<{ id: string }>(env.DB, 'SELECT id FROM template_candidates WHERE template_id = ?', [
      templateId,
    ])
  ).length;

async function ok(res: Response) {
  expect(res.status, await res.clone().text()).toBe(200);
  return ReleaseResultSchema.parse(await res.json());
}

beforeAll(async () => {
  clock = new ManualClock();
  env = await makeEnv({
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

describe('release in one call', () => {
  it('releases a solo admin to Test and Live with a test and a sole approval', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Solo Flow', org, owner);
    const result = await ok(await release(t.templateId, org, t.version, owner));
    expect(result).toMatchObject({
      version: t.version,
      modes: {
        test: { outcome: 'released', generation: 1, approvalKind: 'test' },
        live: { outcome: 'released', generation: 1, approvalKind: 'sole' },
      },
      state: { live: { version: t.version }, test: { state: 'following' }, next: null },
    });
    expect(await heads(t.templateId)).toEqual([
      { mode: 'live', version: t.version, generation: 1 },
      { mode: 'test', version: t.version, generation: 1 },
    ]);
    expect(await approvals(t.templateId)).toEqual([
      { mode: 'live', kind: 'sole' },
      { mode: 'test', kind: 'test' },
    ]);
    const audited = await all<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'template.release'",
      [t.templateId],
    );
    expect(audited.map((a) => JSON.parse(a.detail).mode).sort()).toEqual(['live', 'test']);
  });

  it('answers a team 409 with the plan and resumes after a peer approves', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Team Flow', org, owner);
    const res = await release(t.templateId, org, t.version, owner);
    await expectProblem(res, 409, 'TEMPLATE_REVIEW_REQUIRED');
    const plan = ReleasePlanSchema.parse(((await res.json()) as { plan: unknown }).plan);
    expect(plan.modes.live).toMatchObject({
      outcome: 'review_required',
      candidate: { action: 'reuse' },
      approval: { action: 'needed', kind: null },
    });
    expect(plan.modes.test).toMatchObject({ outcome: 'current' });
    expect(await heads(t.templateId)).toEqual([
      { mode: 'test', version: t.version, generation: 1 },
    ]);
    expect(await candidates(t.templateId)).toBe(2);

    const live = await first<{ id: string; candidate_hash: string }>(
      env.DB,
      "SELECT id, candidate_hash FROM template_candidates WHERE template_id = ? AND mode = 'live'",
      [t.templateId],
    );
    const approved = await send(
      `/${t.templateId}/candidates/${live?.id}/approve`,
      { orgId: org.id, mode: 'live', provider: 'apple', candidateHash: live?.candidate_hash },
      reviewer,
    );
    expect(approved.status).toBe(201);
    const result = await ok(await release(t.templateId, org, t.version, owner));
    expect(result.modes).toMatchObject({
      test: { outcome: 'current' },
      live: { outcome: 'released', approvalKind: 'peer' },
    });
    expect(await candidates(t.templateId)).toBe(2);
  });

  it('a reviewer added after a Try turns a solo release into a resumable 409', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Mid Flow', org, owner);
    await ok(await release(t.templateId, org, t.version, owner, { modes: ['test'] }));
    await member(org.id, ['template_reviewer']);
    const res = await release(t.templateId, org, t.version, owner);
    await expectProblem(res, 409, 'TEMPLATE_REVIEW_REQUIRED');
    const { plan } = (await res.json()) as { plan: ReleasePlan };
    expect(plan.state).toMatchObject({ alone: false, next: 'wait' });
    expect(await heads(t.templateId)).toEqual([
      { mode: 'test', version: t.version, generation: 1 },
    ]);
    expect(await candidates(t.templateId)).toBe(2);
    await expectProblem(
      await release(t.templateId, org, t.version, owner),
      409,
      'TEMPLATE_REVIEW_REQUIRED',
    );
    expect(await candidates(t.templateId)).toBe(2);
  });

  it('replays a key, refuses it with another body, and requires one', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Replay Flow', org, owner);
    const body = { orgId: org.id, version: t.version };
    const first = await send(`/${t.templateId}/release`, body, owner, { key: 'same-key' });
    const result = await ok(first);
    const again = await send(`/${t.templateId}/release`, body, owner, { key: 'same-key' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.json()).toEqual(result);
    expect((await heads(t.templateId)).length).toBe(2);
    await expectProblem(
      await send(`/${t.templateId}/release`, { ...body, modes: ['test'] }, owner, {
        key: 'same-key',
      }),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectProblem(
      await send(`/${t.templateId}/release`, body, owner, { key: null }),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  });

  it('keeps a Test head newer than the released version', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const v1 = await uploaded('Ahead Flow', org, owner, 90);
    await ok(await release(v1.templateId, org, v1.version, owner));
    clock.advance(1000);
    const v2 = await uploaded('Ahead Flow', org, owner, 96);
    clock.advance(1000);
    const v3 = await uploaded('Ahead Flow', org, owner, 98);
    const tried = await ok(
      await release(v1.templateId, org, v3.version, owner, { modes: ['test'] }),
    );
    expect(tried.state.test).toMatchObject({ version: v3.version, state: 'ahead' });
    const kept = await ok(await release(v1.templateId, org, v2.version, owner));
    expect(kept.modes).toMatchObject({ test: { outcome: 'kept' }, live: { outcome: 'released' } });
    expect(kept.state.test?.version).toBe(v3.version);
    const rows = await heads(v1.templateId);
    expect(rows.filter((r) => r.mode === 'test').map((r) => r.version)).toEqual([
      v1.version,
      v3.version,
    ]);
    expect(rows.filter((r) => r.mode === 'live').map((r) => r.version)).toEqual([
      v1.version,
      v2.version,
    ]);
  });

  it('follows after a Try of an older version with no Live head', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const v1 = await uploaded('Try Flow', org, owner, 90);
    await ok(await release(v1.templateId, org, v1.version, owner, { modes: ['test'] }));
    clock.advance(1000);
    const v2 = await uploaded('Try Flow', org, owner, 96);
    const result = await ok(await release(v1.templateId, org, v2.version, owner));
    expect(result.modes).toMatchObject({
      test: { outcome: 'released', generation: 2 },
      live: { outcome: 'released', generation: 1 },
    });
    expect(result.state.test).toMatchObject({ version: v2.version, state: 'following' });
  });

  it('moves Test with Live when Test trails Live by exactly the previous release', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const v1 = await uploaded('Follow Flow', org, owner, 90);
    await ok(await release(v1.templateId, org, v1.version, owner));
    clock.advance(1000);
    const v2 = await uploaded('Follow Flow', org, owner, 96);
    const moved = await ok(await release(v1.templateId, org, v2.version, owner));
    expect(moved.modes).toMatchObject({
      test: { outcome: 'released', generation: 2 },
      live: { outcome: 'released', generation: 2 },
    });
  });

  it('creates one candidate per mode however many calls run', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    await member(org.id, ['template_reviewer']);
    const t = await uploaded('Once Flow', org, owner);
    await Promise.all(
      [1, 2].map(async () =>
        ok(await release(t.templateId, org, t.version, owner, { request: true })),
      ),
    );
    const settled = await candidates(t.templateId);
    const again = await release(t.templateId, org, t.version, owner, { request: true });
    expect((await ok(again)).modes).toMatchObject({
      test: { outcome: 'review_requested' },
      live: { outcome: 'review_requested' },
    });
    expect(await candidates(t.templateId)).toBe(settled);
    expect(await heads(t.templateId)).toEqual([]);
  });

  it("releases another author's approved candidate and resumes with the same body", async () => {
    const org = await makeOrg(f);
    const author = await member(org.id, ['template_author']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const publisher = await member(org.id, ['template_publisher']);
    const t = await uploaded('Other Flow', org, author);
    const body = { orgId: org.id, version: t.version, modes: ['live'], expected: { live: 0 } };
    await ok(await send(`/${t.templateId}/review-requests`, body, author));
    const live = await first<{ id: string; candidate_hash: string }>(
      env.DB,
      "SELECT id, candidate_hash FROM template_candidates WHERE template_id = ? AND mode = 'live'",
      [t.templateId],
    );
    const approved = await send(
      `/${t.templateId}/candidates/${live?.id}/approve`,
      { orgId: org.id, mode: 'live', provider: 'apple', candidateHash: live?.candidate_hash },
      reviewer,
    );
    expect(approved.status).toBe(201);
    const result = await ok(await send(`/${t.templateId}/release`, body, publisher));
    expect(result.modes.live).toMatchObject({ outcome: 'released', approvalKind: 'peer' });
    expect(await candidates(t.templateId)).toBe(1);
  });

  it('a dry run lists what apply then does', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Dry Flow', org, owner);
    const dry = await send(
      `/${t.templateId}/release`,
      { orgId: org.id, version: t.version },
      owner,
      {
        key: null,
        query: '?dryRun=true',
      },
    );
    expect(dry.status).toBe(200);
    const plan = ReleasePlanSchema.parse(await dry.json());
    expect(plan).toMatchObject({
      fromVersion: null,
      modes: {
        test: { outcome: 'release', candidate: { action: 'create' }, approval: { kind: 'test' } },
        live: { outcome: 'release', candidate: { action: 'create' }, approval: { kind: 'sole' } },
      },
      state: { next: 'try' },
    });
    expect(await candidates(t.templateId)).toBe(0);
    const result = await ok(await release(t.templateId, org, t.version, owner));
    expect(result.modes.test?.approvalKind).toBe(plan.modes.test?.approval.kind);
    expect(result.modes.live?.approvalKind).toBe(plan.modes.live?.approval.kind);
    const after = ReleasePlanSchema.parse(
      await (
        await send(`/${t.templateId}/release`, { orgId: org.id, version: t.version }, owner, {
          key: null,
          query: '?dryRun=true',
        })
      ).json(),
    );
    expect(after.modes).toMatchObject({
      test: { outcome: 'current' },
      live: { outcome: 'current' },
    });
  });

  it("lets a reviewer without publish read the plan, and refuses the reviewer's real release", async () => {
    const org = await makeOrg(f);
    const author = await member(org.id, ['template_author']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const t = await uploaded('Review Plan', org, author);
    const body = { orgId: org.id, version: t.version };
    const dry = await send(`/${t.templateId}/release`, body, reviewer, {
      key: null,
      query: '?dryRun=true',
    });
    expect(dry.status).toBe(200);
    ReleasePlanSchema.parse(await dry.json());
    expect(await candidates(t.templateId)).toBe(0);
    await expectProblem(await send(`/${t.templateId}/release`, body, reviewer), 403, 'FORBIDDEN');
  });

  it('keeps the dry run for a publisher who cannot review', async () => {
    const org = await makeOrg(f);
    const author = await member(org.id, ['template_author']);
    const publisher = await member(org.id, ['template_publisher']);
    const t = await uploaded('Publisher Plan', org, author);
    const dry = await send(
      `/${t.templateId}/release`,
      { orgId: org.id, version: t.version },
      publisher,
      {
        key: null,
        query: '?dryRun=true',
      },
    );
    expect(dry.status).toBe(200);
    expect(await candidates(t.templateId)).toBe(0);
  });

  it('shows a typed diff against the Live version', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const v1 = await uploaded('Diff Flow', org, owner, 90);
    await ok(await release(v1.templateId, org, v1.version, owner));
    clock.advance(1000);
    const v2 = await uploaded('Diff Flow', org, owner, 96);
    const dry = ReleasePlanSchema.parse(
      await (
        await send(`/${v1.templateId}/release`, { orgId: org.id, version: v2.version }, owner, {
          key: null,
          query: '?dryRun=true',
        })
      ).json(),
    );
    expect(dry.fromVersion).toBe(v1.version);
    expect(dry.diff).toEqual([
      expect.objectContaining({
        group: 'images',
        rows: [expect.objectContaining({ to: expect.objectContaining({ type: 'image' }) })],
      }),
    ]);
  });
});

describe('modes by key and sandbox', () => {
  it('a Test key releases Test only and cannot name Live', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Key Flow', org, owner);
    const test = await key(org.id, owner.userId);
    const result = await ok(await send(`/${t.templateId}/release`, { version: t.version }, test));
    expect(Object.keys(result.modes)).toEqual(['test']);
    expect(result.modes.test).toMatchObject({ outcome: 'released', approvalKind: 'test' });
    await expectProblem(
      await send(`/${t.templateId}/release`, { version: t.version, modes: ['live'] }, test),
      403,
      'KEY_TEST_ONLY',
    );
  });

  it('a Live key cannot release', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Live Key Flow', org, owner);
    const live = await key(org.id, owner.userId, 'live');
    await expectProblem(
      await send(`/${t.templateId}/release`, { version: t.version }, live),
      403,
      'KEY_TEST_ONLY',
    );
    expect(await heads(t.templateId)).toEqual([]);
  });

  it('a developer org releases Test only', async () => {
    const org = await makeOrg(f, { kind: 'developer' });
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Sandbox Flow', org, owner, undefined, true);
    const inTest = (body: object) =>
      send(`/${t.templateId}/release`, { orgId: org.id, version: t.version, ...body }, owner, {
        mode: 'test',
      });
    await expectProblem(await inTest({ modes: ['live'] }), 409, 'SANDBOX_TEST_ONLY');
    const result = await ok(await inTest({}));
    expect(Object.keys(result.modes)).toEqual(['test']);
  });
});

describe('key scopes and Live review requests', () => {
  it('answers a key without a step scope the same way in a dry run and in apply', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Scope Flow', org, owner);
    const thin = await key(org.id, owner.userId, 'test', ['templates:review']);
    const body = { version: t.version };
    await expectProblem(
      await send(`/${t.templateId}/release`, body, thin, { key: null, query: '?dryRun=true' }),
      403,
      'MISSING_SCOPE',
    );
    await expectProblem(await send(`/${t.templateId}/release`, body, thin), 403, 'MISSING_SCOPE');
  });

  it('lets a Live key request review only', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Live Request Flow', org, owner);
    const live = await key(org.id, owner.userId, 'live');
    const result = await ok(
      await send(`/${t.templateId}/review-requests`, { version: t.version }, live),
    );
    expect(result.modes).toMatchObject({ live: { outcome: 'review_requested' } });
    expect(Object.keys(result.modes)).toEqual(['live']);
    await expectProblem(
      await send(`/${t.templateId}/release`, { version: t.version }, live),
      403,
      'KEY_TEST_ONLY',
    );
    expect(await approvals(t.templateId)).toEqual([]);
    expect(await heads(t.templateId)).toEqual([]);
    expect(await candidates(t.templateId)).toBe(1);
  });
});

describe('review request alias', () => {
  it('creates candidates without approving or releasing', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const author = await member(org.id, ['template_author']);
    const t = await uploaded('Alias Flow', org, owner);
    const res = await send(
      `/${t.templateId}/review-requests`,
      { orgId: org.id, version: t.version },
      author,
    );
    const result = await ok(res);
    expect(result.modes.live?.outcome).toBe('review_requested');
    expect(await candidates(t.templateId)).toBe(2);
    expect(await approvals(t.templateId)).toEqual([]);
    const row = await first<{ id: string }>(
      env.DB,
      'SELECT id FROM template_candidates WHERE template_id = ?',
      [t.templateId],
    );
    expect(TemplateCandidateSchema.shape.id.safeParse(row?.id).success).toBe(true);
  });
});

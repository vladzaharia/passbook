import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  countD1,
  type Fixtures,
  fakeRateLimiter,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeScanner,
  makeSession,
  makeUser,
  type OrgRow,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import {
  TemplateApprovalSchema,
  type TemplateCandidate,
  TemplateCandidateSchema,
  type TemplateRelease,
  TemplateReleaseSchema,
  type TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from '../scan/auth-store.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { resetBakedSync, syncBakedTemplates } from './sync.ts';
import { bakedFrom, fakeAssets, importZip, sourceOf } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const EligibleItemSchema = z.strictObject({
  templateId: z.string().min(1),
  name: z.string(),
  templateOrgId: z.string().nullable(),
  origin: z.enum(['uploaded', 'baked']),
  releaseId: z.string().min(1),
  releaseGeneration: z.number().int().positive(),
  version: z.string().min(1),
  candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
  supportsCheckIn: z.boolean(),
});
const EligiblePageSchema = z.strictObject({
  items: z.array(EligibleItemSchema),
  nextCursor: z.string().nullable(),
});
type EligiblePage = z.infer<typeof EligiblePageSchema>;
type Mode = TemplateReleaseScope['mode'];
interface Actor {
  userId: string;
  headers: Record<string, string>;
}
interface Actors {
  author: Actor;
  reviewer: Actor;
}
interface ImportedTemplate {
  id: string;
  version: string;
  name: string;
}

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let assets: ReturnType<typeof fakeAssets>;
let app: ReturnType<typeof createApp>;
let org: OrgRow;
let otherOrg: OrgRow;
let own: Actors;
let other: Actors;

async function member(orgId: string, roles: OrgRole[], platformAdmin = false): Promise<Actor> {
  const user = await makeUser(f);
  const now = clock.now();
  const invitationId = f.ids.id();
  const json = JSON.stringify(roles);
  await run(
    env.DB,
    `INSERT INTO org_invitations
    (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, json, f.ids.token(), now, now + 3_600_000, now, user.id],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, user.id, invitationId, json, now],
  );
  const session = await makeSession(f, {
    userId: user.id,
    roles: platformAdmin ? ['admin', 'user'] : ['user'],
  });
  return { userId: user.id, headers: session.headers };
}

const scope = (orgId: string, mode: Mode = 'live'): TemplateReleaseScope => ({
  orgId,
  mode,
  provider: 'apple',
});
const request = (
  path: string,
  headers: Record<string, string> = {},
  mode: Mode = 'live',
  init: RequestInit = {},
  requestEnv: AppEnv = env,
) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    {
      ...init,
      headers: {
        ...headers,
        ...(mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
        ...init.headers,
      },
    },
    requestEnv,
  );
const post = (path: string, body: unknown, actor: Actor, mode: Mode) =>
  request(path, actor.headers, mode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const eligibleRequest = (
  s: TemplateReleaseScope,
  headers: Record<string, string>,
  extra: Record<string, string> = {},
  requestMode: Mode = s.mode,
  requestEnv: AppEnv = env,
) =>
  request(
    `/eligible?${new URLSearchParams({ ...s, ...extra })}`,
    headers,
    requestMode,
    {},
    requestEnv,
  );
async function eligible(
  s: TemplateReleaseScope,
  actor: Actor,
  extra: Record<string, string> = {},
  requestEnv: AppEnv = env,
): Promise<EligiblePage> {
  const response = await eligibleRequest(s, actor.headers, extra, s.mode, requestEnv);
  expect(response.status).toBe(200);
  return EligiblePageSchema.parse(await response.json());
}

async function imported(
  name: string,
  tenant: OrgRow = org,
  author: Actor = own.author,
  options: { logoWidth?: number; scan?: { actions: Record<string, string>[] } } = {},
): Promise<ImportedTemplate> {
  const manifest = {
    schema: 1,
    name,
    inputs: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, points: { type: 'integer' } },
    },
    sample: { name: 'Alex', points: 0 },
    bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
    display: { title: '{{name}}' },
    ...(options.scan ? { scan: options.scan } : {}),
  };
  const extra: Record<string, Uint8Array | string> = {
    'wallet.template.json': JSON.stringify(manifest),
  };
  if (options.logoWidth) extra['logo.png'] = makePng(options.logoWidth, 40);
  const result = await importZip(env, clock, {
    orgId: tenant.id,
    createdBy: author.userId,
    name,
    zip: zipOf(basicPackage(extra)),
  });
  if (!result.result) throw new Error(`Template import failed at ${result.stages.join(', ')}`);
  return { id: result.result.templateId, version: result.result.version, name };
}

async function candidate(
  t: ImportedTemplate,
  s: TemplateReleaseScope,
  actor: Actor,
): Promise<TemplateCandidate> {
  const response = await post(`/${t.id}/candidates`, { ...s, version: t.version }, actor, s.mode);
  expect(response.status).toBe(201);
  return TemplateCandidateSchema.parse(await response.json());
}
async function approve(
  t: ImportedTemplate,
  c: TemplateCandidate,
  s: TemplateReleaseScope,
  actor: Actor,
) {
  const response = await post(
    `/${t.id}/candidates/${c.id}/approve`,
    {
      ...s,
      candidateHash: c.candidateHash,
    },
    actor,
    s.mode,
  );
  expect(response.status).toBe(201);
  return TemplateApprovalSchema.parse(await response.json());
}
async function release(
  t: ImportedTemplate,
  s: TemplateReleaseScope,
  actors: Actors,
  expectedGeneration = 0,
): Promise<TemplateRelease> {
  const c = await candidate(t, s, actors.author);
  const a = await approve(t, c, s, actors.reviewer);
  const response = await post(
    `/${t.id}/releases`,
    {
      ...s,
      candidateId: c.id,
      approvalId: a.id,
      candidateHash: c.candidateHash,
      expectedGeneration,
    },
    actors.author,
    s.mode,
  );
  expect(response.status).toBe(201);
  return TemplateReleaseSchema.parse(await response.json());
}
function expectUploaded(
  page: EligiblePage,
  template: ImportedTemplate,
  row: TemplateRelease,
  templateOrgId: string | null,
  supportsCheckIn = true,
) {
  expect(page.items.filter((item) => item.templateId === template.id)).toEqual([
    {
      templateId: template.id,
      name: template.name,
      templateOrgId,
      origin: 'uploaded',
      releaseId: row.id,
      releaseGeneration: row.generation,
      version: row.version,
      candidateHash: row.candidateHash,
      supportsCheckIn,
    },
  ]);
}
function expectAbsent(page: EligiblePage, ...ids: string[]) {
  expect(page.items.filter((item) => ids.includes(item.templateId))).toEqual([]);
}

beforeEach(async () => {
  clock = new ManualClock(Date.now());
  assets = fakeAssets();
  env = await makeEnv({
    ASSETS: assets,
    RL_API_KEY: fakeRateLimiter({ limit: 1000 }),
    CF_VERSION: { id: 'eligible-worker', tag: '', timestamp: '9990-01-01T00:00:00Z' },
  });
  f = fixtures(env, clock);
  app = createApp({
    stores: {
      sessions: createSessionStore(env, clock),
      apiKeys: createApiKeyStore(env, clock),
      scanners: createScannerStore(env, clock),
    },
    clock,
  });
  org = await makeOrg(f);
  otherOrg = await makeOrg(f);
  own = {
    author: await member(org.id, ['template_author', 'template_publisher']),
    reviewer: await member(org.id, ['template_reviewer']),
  };
  other = {
    author: await member(otherOrg.id, ['template_author', 'template_publisher']),
    reviewer: await member(otherOrg.id, ['template_reviewer']),
  };
});
afterEach(() => resetBakedSync());

describe('eligible template releases', () => {
  it('selects only exact org and mode releases, including separately approved shared uploads', async () => {
    const owned = await imported('Eligible Owned A');
    const foreign = await imported('Eligible Owned B', otherOrg, other.author);
    const sandbox = await imported('Eligible Test Only');
    const draft = await imported('Eligible Draft');
    const pending = await imported('Eligible Unapproved');
    const reviewed = await imported('Eligible Approved Not Released');
    const shared = await imported('Eligible Shared');
    const sharedV2 = await imported('Eligible Shared', org, own.author, { logoWidth: 100 });
    expect(sharedV2.id).toBe(shared.id);
    expect(sharedV2.version).not.toBe(shared.version);
    const admin = await member(org.id, ['org_admin'], true);
    const assign = await request(`/${shared.id}`, admin.headers, 'live', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: null }),
    });
    expect(assign.status).toBe(200);
    // A legacy global pointer is not a release and must never serve as a fallback.
    await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      shared.version,
      shared.id,
    ]);

    const ownLive = await release(owned, scope(org.id), own);
    const otherLive = await release(foreign, scope(otherOrg.id), other);
    const testOnly = await release(sandbox, scope(org.id, 'test'), own);
    await candidate(pending, scope(org.id), own.author);
    const reviewedCandidate = await candidate(reviewed, scope(org.id), own.author);
    await approve(reviewed, reviewedCandidate, scope(org.id), own.reviewer);
    const sharedA = await release(shared, scope(org.id), own);
    expectAbsent(await eligible(scope(otherOrg.id), other.author), shared.id, owned.id);
    expectAbsent(await eligible(scope(org.id, 'test'), own.author), shared.id, owned.id);

    const sharedB = await release(sharedV2, scope(otherOrg.id), other);
    const sharedTestA = await release(sharedV2, scope(org.id, 'test'), own);
    const third = await makeOrg(f);
    const thirdReader = await member(third.id, ['pass_operator']);
    const aLive = await eligible(scope(org.id), own.author);
    const aTest = await eligible(scope(org.id, 'test'), own.author);
    const bLive = await eligible(scope(otherOrg.id), other.author);
    const bTest = await eligible(scope(otherOrg.id, 'test'), other.author);
    expectUploaded(aLive, owned, ownLive, org.id);
    expectUploaded(aLive, shared, sharedA, null);
    expectUploaded(aTest, sandbox, testOnly, org.id);
    expectUploaded(aTest, sharedV2, sharedTestA, null);
    expectUploaded(bLive, foreign, otherLive, otherOrg.id);
    expectUploaded(bLive, sharedV2, sharedB, null);
    expectAbsent(aLive, foreign.id, sandbox.id, draft.id, pending.id, reviewed.id);
    expectAbsent(aTest, owned.id, foreign.id, draft.id, pending.id, reviewed.id);
    expectAbsent(bLive, owned.id, sandbox.id, draft.id, pending.id, reviewed.id);
    expectAbsent(bTest, owned.id, foreign.id, sandbox.id, shared.id);
    expectAbsent(await eligible(scope(third.id), thirdReader), shared.id, owned.id, foreign.id);
    expectAbsent(await eligible(scope(third.id, 'test'), thirdReader), shared.id, sandbox.id);
  }, 60_000);

  it('uses the effective release manifest and replaces superseded release generations', async () => {
    const checkedIn = await imported('Eligible Scan Policy', org, own.author, {
      scan: { actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }] },
    });
    const addOnly = await imported('Eligible Scan Policy', org, own.author, {
      scan: { actions: [{ id: 'add', label: 'Add', kind: 'add', input: 'points' }] },
    });
    const defaultScan = await imported('Eligible Scan Policy');
    expect(addOnly.id).toBe(checkedIn.id);
    expect(defaultScan.id).toBe(checkedIn.id);
    expect(new Set([checkedIn.version, addOnly.version, defaultScan.version]).size).toBe(3);

    const firstLive = await release(checkedIn, scope(org.id), own);
    expectUploaded(await eligible(scope(org.id), own.author), checkedIn, firstLive, org.id, true);
    const testRelease = await release(addOnly, scope(org.id, 'test'), own);
    expectUploaded(
      await eligible(scope(org.id, 'test'), own.author),
      addOnly,
      testRelease,
      org.id,
      false,
    );
    expectUploaded(await eligible(scope(org.id), own.author), checkedIn, firstLive, org.id, true);

    const secondLive = await release(addOnly, scope(org.id), own, 1);
    expect(secondLive.previousReleaseId).toBe(firstLive.id);
    expect(secondLive.generation).toBe(2);
    const afterPublish = await eligible(scope(org.id), own.author);
    expectUploaded(afterPublish, addOnly, secondLive, org.id, false);
    expect(afterPublish.items.map((item) => item.releaseId)).not.toContain(firstLive.id);
    // The already imported, newer default-scan draft must not affect the current release.
    const thirdLive = await release(defaultScan, scope(org.id), own, 2);
    expect(thirdLive.previousReleaseId).toBe(secondLive.id);
    expect(thirdLive.generation).toBe(3);
    const afterDefault = await eligible(scope(org.id), own.author);
    expectUploaded(afterDefault, defaultScan, thirdLive, org.id, true);
    expect(afterDefault.items.map((item) => item.releaseId)).not.toContain(secondLive.id);
    expectUploaded(
      await eligible(scope(org.id, 'test'), own.author),
      addOnly,
      testRelease,
      org.id,
      false,
    );

    const rollbackResponse = await post(
      `/${checkedIn.id}/releases/rollback`,
      {
        ...scope(org.id),
        releaseId: firstLive.id,
        candidateHash: firstLive.candidateHash,
        expectedGeneration: 3,
        reason: 'Restore the previously approved release',
      },
      own.author,
      'live',
    );
    expect(rollbackResponse.status).toBe(201);
    const rollback = TemplateReleaseSchema.parse(await rollbackResponse.json());
    expect(rollback).toMatchObject({
      generation: 4,
      previousReleaseId: thirdLive.id,
      version: checkedIn.version,
    });
    const afterRollback = await eligible(scope(org.id), own.author);
    expectUploaded(afterRollback, checkedIn, rollback, org.id, true);
    expect(afterRollback.items.map((item) => item.releaseId)).not.toContain(thirdLive.id);
  }, 60_000);

  it('excludes archived templates even when they have an approved release', async () => {
    const template = await imported('Eligible Archived');
    const published = await release(template, scope(org.id), own);
    expectUploaded(await eligible(scope(org.id), own.author), template, published, org.id);
    const archived = await post(`/${template.id}/archive`, {}, own.author, 'live');
    expect(archived.status).toBe(200);
    expectAbsent(await eligible(scope(org.id), own.author), template.id);
  }, 30_000);

  it('authorizes either read capability while fencing sessions, API keys, modes and scanners', async () => {
    const template = await imported('Eligible Authorization');
    const published = await release(template, scope(org.id), own);
    const operator = await member(org.id, ['pass_operator']);
    const integration = await member(org.id, ['integration_admin']);
    expectUploaded(await eligible(scope(org.id), own.author), template, published, org.id);
    expectUploaded(await eligible(scope(org.id), operator), template, published, org.id);
    // integration_admin holds templates:read, which is enough for this route.
    expectUploaded(await eligible(scope(org.id), integration), template, published, org.id);
    expect((await eligibleRequest(scope(org.id), other.author.headers)).status).toBe(403);
    expect((await eligibleRequest(scope(org.id), {})).status).toBe(401);
    const platformUser = await makeUser(f);
    const platformSession = await makeSession(f, {
      userId: platformUser.id,
      roles: ['admin', 'user'],
    });
    expect((await eligibleRequest(scope(org.id), platformSession.headers)).status).toBe(403);

    const templateKey = await makeApiKey(f, { orgId: org.id, scopes: ['templates:read'] });
    const passKey = await makeApiKey(f, { orgId: org.id, scopes: ['passes:read'] });
    const wrongScope = await makeApiKey(f, { orgId: org.id, scopes: ['scans:read'] });
    const wrongOrg = await makeApiKey(f, { orgId: otherOrg.id, scopes: ['templates:read'] });
    for (const key of [templateKey, passKey]) {
      const response = await eligibleRequest(scope(org.id), key.headers);
      expect(response.status).toBe(200);
      expectUploaded(EligiblePageSchema.parse(await response.json()), template, published, org.id);
      expect((await eligibleRequest(scope(org.id, 'test'), key.headers)).status).toBe(403);
    }
    expect((await eligibleRequest(scope(org.id), wrongScope.headers)).status).toBe(403);
    expect((await eligibleRequest(scope(org.id), wrongOrg.headers)).status).toBe(403);
    const sandboxRelease = await release(template, scope(org.id, 'test'), own);
    const testKey = await makeApiKey(f, { orgId: org.id, scopes: ['passes:read'], mode: 'test' });
    const testResponse = await eligibleRequest(scope(org.id, 'test'), testKey.headers, {}, 'live');
    expect(testResponse.status).toBe(200);
    expectUploaded(
      EligiblePageSchema.parse(await testResponse.json()),
      template,
      sandboxRelease,
      org.id,
    );
    expect((await eligibleRequest(scope(org.id), testKey.headers)).status).toBe(403);
    expect(
      (await eligibleRequest(scope(org.id, 'test'), operator.headers, {}, 'live')).status,
    ).toBe(403);
    expect((await eligibleRequest(scope(org.id), operator.headers, {}, 'test')).status).toBe(403);

    for (const kind of ['device', 'terminal'] as const) {
      const scanner = await makeScanner(f, { orgId: org.id, kind });
      const response = await eligibleRequest(scope(org.id), scanner.headers);
      expect([401, 403]).toContain(response.status);
    }
    await run(
      env.DB,
      'UPDATE org_memberships SET revoked_at = ? WHERE org_id = ? AND user_id = ?',
      [clock.now(), org.id, operator.userId],
    );
    expect((await eligibleRequest(scope(org.id), operator.headers)).status).toBe(403);
  }, 60_000);

  it('rejects unsupported providers, missing scope, mismatched modes and invalid limits', async () => {
    for (const provider of ['google', 'samsung']) {
      const response = await eligibleRequest(scope(org.id), own.author.headers, { provider });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'TEMPLATE_PROVIDER_UNSUPPORTED' });
    }
    const invalidQueries: Record<string, string>[] = [
      { mode: 'live', provider: 'apple' },
      { orgId: org.id, provider: 'apple' },
      { orgId: org.id, mode: 'live' },
      { orgId: org.id, mode: 'other', provider: 'apple' },
      { orgId: org.id, mode: 'live', provider: 'other' },
      ...['0', '-1', '201', '1.5', 'nope'].map((limit) => ({ ...scope(org.id), limit })),
      { ...scope(org.id), cursor: '' },
      { ...scope(org.id), cursor: 'x'.repeat(65) },
    ];
    for (const params of invalidQueries) {
      const response = await request(
        `/eligible?${new URLSearchParams(params)}`,
        own.author.headers,
      );
      expect(response.status).toBe(422);
    }
  });

  it('paginates without gaps or duplicates using one bounded release selection per page', async () => {
    const templates = [];
    for (const name of ['Eligible Page A', 'Eligible Page B', 'Eligible Page C']) {
      const template = await imported(name);
      await release(template, scope(org.id), own);
      templates.push(template);
    }
    const counted = countD1(env.DB);
    const traced = { ...env, DB: counted.db };
    const pageWithBudget = async (extra: Record<string, string>) => {
      counted.reset();
      const page = await eligible(scope(org.id), own.author, extra, traced);
      const selections = counted
        .sql()
        .filter((sql) =>
          /\b(?:FROM|JOIN)\s+["`[]?(?:templates|template_releases|template_versions)\b/i.test(sql),
        );
      expect(selections).toHaveLength(1);
      expect(selections[0]).toMatch(/\btemplate_releases\b/i);
      expect(selections[0]).toMatch(/\bLIMIT\s+\?\s*;?\s*$/i);
      return page;
    };
    const whole = await pageWithBudget({ limit: '200' });
    expect(whole.nextCursor).toBeNull();
    for (const template of templates)
      expect(whole.items.map((item) => item.templateId)).toContain(template.id);
    const seen: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: EligiblePage = await pageWithBudget(
        cursor ? { limit: '1', cursor } : { limit: '1' },
      );
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      if (!item) throw new Error('Expected a page item');
      seen.push(item.templateId);
      cursor = page.nextCursor;
      if (cursor) {
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
      }
    } while (cursor && cursors.size <= whole.items.length);
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(whole.items.map((item) => item.templateId));
  }, 60_000);

  it('falls back only to verified global or matching-org baked system releases', async () => {
    const global = await bakedFrom('eligible-global', basicPackage(), {
      name: 'Eligible Global Baked',
    });
    const ownBaked = await bakedFrom('eligible-owned', basicPackage(), {
      name: 'Eligible Owned Baked',
      org: { slug: org.slug, name: org.name },
    });
    const foreignBaked = await bakedFrom('eligible-foreign', basicPackage(), {
      name: 'Eligible Foreign Baked',
      org: { slug: otherOrg.slug, name: otherOrg.name },
    });
    const unavailable = await bakedFrom('eligible-unavailable', basicPackage(), {
      name: 'Unavailable Baked',
    });
    const missing = unavailable.template.assets[0]?.source.path;
    if (!missing) throw new Error('Baked fixture has no asset');
    for (const fixture of [global, ownBaked, foreignBaked, unavailable]) {
      for (const [path, bytes] of fixture.files)
        if (path !== missing) assets.files.set(path, bytes);
    }
    const settingsWhere = `scope = 'system' AND
      (key IN ('templates.baked_adoption', 'templates.baked_hash') OR key LIKE 'templates.baked_seen:eligible-%')`;
    const savedSettings = await all<{ key: string; value: string; updated_at: number }>(
      env.DB,
      `SELECT key, value, updated_at FROM settings WHERE ${settingsWhere}`,
    );
    try {
      const syncEnv = {
        ...env,
        CF_VERSION: { id: 'eligible-baked', tag: '', timestamp: '9991-01-01T00:00:00Z' },
      };
      await syncBakedTemplates(
        createServiceContext(syncEnv, { clock }),
        sourceOf([global, ownBaked, foreignBaked, unavailable], 'eligible-baked-fixtures'),
      );
      const systemRow = async (templateId: string, mode: Mode) => {
        const row = await first<{
          id: string;
          org_id: string | null;
          version: string;
          generation: number;
          candidate_hash: string;
          source: string;
          action: string;
        }>(
          env.DB,
          `SELECT id, org_id, version, generation, candidate_hash, source, action
          FROM template_releases WHERE template_id = ? AND mode = ? AND provider = 'apple'
          ORDER BY generation DESC LIMIT 1`,
          [templateId, mode],
        );
        expect(row).not.toBeNull();
        if (!row) throw new Error('Expected verified system release');
        expect(row).toMatchObject({ source: 'system', action: 'system' });
        return row;
      };
      const globalLive = await systemRow(global.template.id, 'live');
      const globalTest = await systemRow(global.template.id, 'test');
      const ownedLive = await systemRow(ownBaked.template.id, 'live');
      expect(globalLive.org_id).toBeNull();
      expect(globalTest.org_id).toBeNull();
      expect(ownedLive.org_id).toBe(org.id);
      const bakedItem = (
        fixture: typeof global,
        row: typeof globalLive,
        templateOrgId: string | null,
      ) => ({
        templateId: fixture.template.id,
        name: fixture.template.name,
        templateOrgId,
        origin: 'baked',
        releaseId: row.id,
        releaseGeneration: row.generation,
        version: row.version,
        candidateHash: row.candidate_hash,
        supportsCheckIn: true,
      });
      const aLive = await eligible(scope(org.id), own.author);
      const aTest = await eligible(scope(org.id, 'test'), own.author);
      const bLive = await eligible(scope(otherOrg.id), other.author);
      expect(aLive.items).toContainEqual(bakedItem(global, globalLive, null));
      expect(aLive.items).toContainEqual(bakedItem(ownBaked, ownedLive, org.id));
      expect(aTest.items).toContainEqual(bakedItem(global, globalTest, null));
      expect(bLive.items).toContainEqual(bakedItem(global, globalLive, null));
      expectAbsent(aLive, foreignBaked.template.id, unavailable.template.id);
      expectAbsent(bLive, ownBaked.template.id, unavailable.template.id);
      expect(
        await all(env.DB, 'SELECT id FROM template_releases WHERE template_id = ?', [
          unavailable.template.id,
        ]),
      ).toEqual([]);
    } finally {
      await run(env.DB, `DELETE FROM settings WHERE ${settingsWhere}`);
      for (const row of savedSettings) {
        await run(
          env.DB,
          "INSERT INTO settings (scope, key, value, updated_at) VALUES ('system', ?, ?, ?)",
          [row.key, row.value, row.updated_at],
        );
      }
      resetBakedSync();
    }
  }, 60_000);
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeScanEvent,
  makeSession,
  makeUser,
  type OrgRow,
} from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import {
  TemplateApprovalSchema,
  TemplateCandidateSchema,
  TemplateReleaseImpactSchema,
  TemplateReleaseSchema,
} from '../../../shared/contracts/template-releases.ts';
import { TemplateRolloutSchema } from '../../../shared/contracts/template-rollout.ts';
import { TemplateListSchema } from '../../../shared/contracts/templates.ts';
import { createApp } from '../../app.ts';
import * as templateSyncModule from '../../jobs/template-sync.ts';
import { templateSyncGrant } from '../../jobs/template-sync.ts';
import { jobGrant } from '../../platform/authority.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  RACE_TEMPLATE_APPROVAL_INSERT,
  RACE_TEMPLATE_RELEASE_INSERT,
  RACE_TEMPLATE_VERSION_INSERT,
} from '../scan/race-tags.ts';
import { authorizeTemplateWrite } from './access.ts';
import { basicPackage, passJson, zipOf } from './package/fixtures.ts';
import { createTemplateRegistry } from './registry.ts';
import { getTemplate } from './repo.ts';
import { archiveUploadedTemplate } from './repo-mutations.ts';
import { writeApproval, writeRelease } from './repo-release-write.ts';
import { getCandidate } from './repo-releases.ts';
import { recordRolloutFailure } from './repo-rollout.ts';
import { resetBakedSync, syncBakedTemplates } from './sync.ts';
import { bakedFrom, fakeAssets, importZip, sourceOf, watchBatch } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
let assets: ReturnType<typeof fakeAssets>;
let org: OrgRow;
let otherOrg: OrgRow;

interface Actor {
  userId: string;
  membershipId: string;
  cookie: string;
  headers: Record<string, string>;
}
let author: Actor;
let reviewer: Actor;
let publisher: Actor;

async function member(orgId: string, roles: OrgRole[], admin = false): Promise<Actor> {
  const user = await makeUser(f);
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
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
    [membershipId, orgId, user.id, invitationId, json, now],
  );
  const session = await makeSession(f, {
    userId: user.id,
    roles: admin ? ['admin', 'user'] : ['user'],
  });
  return { userId: user.id, membershipId, cookie: session.cookieValue, headers: session.headers };
}

const scope = (orgId = org.id) => ({ orgId, mode: 'live', provider: 'apple' }) as const;
const request = (path: string, actor: Actor, init: RequestInit = {}, e: AppEnv = env) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    { ...init, headers: { ...actor.headers, 'content-type': 'application/json', ...init.headers } },
    e,
  );
const post = (path: string, body: unknown, actor: Actor, e: AppEnv = env) =>
  request(path, actor, { method: 'POST', body: JSON.stringify(body) }, e);

/** Every race installed by a test must have fired, or the test could pass without testing anything. */
const watchers: (() => number)[] = [];
const raceBefore = (
  sql: string,
  action: () => Promise<unknown>,
  base: AppEnv = env,
  options: { always?: boolean } = {},
) => {
  const watched = watchBatch(base, sql, action, options);
  watchers.push(watched.fired);
  return watched.env;
};

const manifest = (name: string) => ({
  schema: 1,
  name,
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
});

async function uploaded(name: string, by: Actor = author, orgId = org.id) {
  const result = await importZip(env, clock, {
    orgId,
    createdBy: by.userId,
    name,
    zip: zipOf(
      basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)) }, passJson()),
    ),
  });
  if (!result.result) throw new Error('Import failed');
  return result.result;
}

async function candidateOf(id: string, version: string, by = author) {
  const res = await post(`/${id}/candidates`, { ...scope(), version }, by);
  expect(res.status).toBe(201);
  return TemplateCandidateSchema.parse(await res.json());
}

async function approve(
  id: string,
  c: { id: string; candidateHash: string },
  by = reviewer,
  e = env,
) {
  return post(
    `/${id}/candidates/${c.id}/approve`,
    { ...scope(), candidateHash: c.candidateHash },
    by,
    e,
  );
}

const publishBody = (
  c: { id: string; candidateHash: string },
  approvalId: string,
  generation = 0,
) => ({
  ...scope(),
  candidateId: c.id,
  approvalId,
  candidateHash: c.candidateHash,
  expectedGeneration: generation,
});

async function reviewed(name: string) {
  const t = await uploaded(name);
  const c = await candidateOf(t.templateId, t.version);
  const a = TemplateApprovalSchema.parse(await (await approve(t.templateId, c)).json());
  return { t, c, a };
}

const releaseCount = async (id: string) =>
  (
    await first<{ n: number }>(
      env.DB,
      'SELECT COUNT(*) AS n FROM template_releases WHERE template_id = ?',
      [id],
    )
  )?.n;

beforeAll(async () => {
  clock = new ManualClock();
  assets = fakeAssets();
  env = await makeEnv({
    ASSETS: assets,
    CF_VERSION: { id: 'default-worker', tag: '', timestamp: '9990-01-01T00:00:00Z' },
  });
  f = fixtures(env, clock);
  app = createApp({ stores: { ...auth.stores, sessions: createSessionStore(env, clock) }, clock });
  org = await makeOrg(f);
  otherOrg = await makeOrg(f);
  author = await member(org.id, ['template_author']);
  reviewer = await member(org.id, ['template_reviewer']);
  publisher = await member(org.id, ['template_publisher']);
});

afterEach(async () => {
  await run(env.DB, "UPDATE orgs SET status = 'active' WHERE id IN (?, ?)", [org.id, otherOrg.id]);
  const fired = watchers.splice(0).map((w) => w());
  expect(fired.every((n) => n > 0)).toBe(true);
});

describe('release writes refuse a changed authority', () => {
  it('refuses a publish after the publisher’s membership is revoked, and leaves no release', async () => {
    const { t, c, a } = await reviewed('Revoked Publisher');
    const leaving = await member(org.id, ['template_publisher']);
    const raced = raceBefore(RACE_TEMPLATE_RELEASE_INSERT, () =>
      run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
        clock.now(),
        leaving.membershipId,
      ]),
    );
    const res = await post(`/${t.templateId}/releases`, publishBody(c, a.id), leaving, raced);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(await releaseCount(t.templateId)).toBe(0);
  });

  it('refuses an approval after the org is suspended', async () => {
    const t = await uploaded('Suspended Org');
    const c = await candidateOf(t.templateId, t.version);
    const raced = raceBefore(RACE_TEMPLATE_APPROVAL_INSERT, () =>
      run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]),
    );
    const res = await approve(t.templateId, c, reviewer, raced);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    expect(
      await all(env.DB, 'SELECT id FROM template_approvals WHERE candidate_id = ?', [c.id]),
    ).toEqual([]);
  });

  it('refuses a publish whose head moved since the caller read it', async () => {
    const { t, c, a } = await reviewed('Head Race');
    const moved = raceBefore(RACE_TEMPLATE_RELEASE_INSERT, async () => {
      await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        t.version,
        t.templateId,
      ]);
      await run(
        env.DB,
        `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version,
           candidate_hash, content_hash, adapter_revision, adapter_capabilities,
           audience_policy_revision, source, action, created_at)
         VALUES (?, ?, ?, 'live', 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'legacy', 'legacy', ?)`,
        [f.ids.id(), t.templateId, org.id, t.version, 'a'.repeat(64), 'b'.repeat(64), clock.now()],
      );
    });
    const res = await post(`/${t.templateId}/releases`, publishBody(c, a.id), publisher, moved);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(
      await all(
        env.DB,
        "SELECT id FROM template_releases WHERE template_id = ? AND source = 'approved'",
        [t.templateId],
      ),
    ).toEqual([]);
  });

  it('never lets a candidate of another org become a head', async () => {
    const { t, c, a } = await reviewed('Foreign Publish');
    const stranger = await member(otherOrg.id, ['template_publisher']);
    const res = await post(
      `/${t.templateId}/releases`,
      { ...publishBody(c, a.id), orgId: otherOrg.id },
      stranger,
    );
    expect([403, 404, 409]).toContain(res.status);
    expect(await releaseCount(t.templateId)).toBe(0);
  });

  it('does not let a reviewer approve their own candidate', async () => {
    const both = await member(org.id, ['template_author', 'template_reviewer']);
    const t = await uploaded('Own Candidate', both);
    const c = await candidateOf(t.templateId, t.version, both);
    await expectProblem(await approve(t.templateId, c, both), 403, 'TEMPLATE_SELF_APPROVAL');
    expect(
      await all(env.DB, 'SELECT id FROM template_approvals WHERE candidate_id = ?', [c.id]),
    ).toEqual([]);
  });
});

describe('release writes survive unrelated org changes', () => {
  const rename = () =>
    run(env.DB, "UPDATE orgs SET name = name || ' renamed' WHERE id = ?", [org.id]);

  it('approves and publishes through an org settings or name save', async () => {
    const t = await uploaded('Settings During Approval');
    const c = await candidateOf(t.templateId, t.version);
    const approving = await approve(
      t.templateId,
      c,
      reviewer,
      raceBefore(RACE_TEMPLATE_APPROVAL_INSERT, rename),
    );
    expect(approving.status).toBe(201);
    const a = TemplateApprovalSchema.parse(await approving.json());
    const res = await post(
      `/${t.templateId}/releases`,
      publishBody(c, a.id),
      publisher,
      raceBefore(RACE_TEMPLATE_RELEASE_INSERT, rename),
    );
    expect(res.status).toBe(201);
    expect(TemplateReleaseSchema.parse(await res.json()).generation).toBe(1);
  });

  it('commits an import through a settings save', async () => {
    const raced = raceBefore(RACE_TEMPLATE_VERSION_INSERT, rename);
    const result = await importZip(raced, clock, {
      orgId: org.id,
      createdBy: author.userId,
      name: 'Import During Save',
      zip: zipOf(
        basicPackage(
          { 'wallet.template.json': JSON.stringify(manifest('Import During Save')) },
          passJson(),
        ),
      ),
    });
    expect(result.result).not.toBeNull();
  });
});

describe('baked sync', () => {
  it('syncs for every org while one is suspended and another is being renamed', async () => {
    const baked = await bakedFrom('grants-baked', basicPackage(), {
      name: 'Grants Baked',
      org: { slug: org.slug, name: org.name },
    });
    for (const [path, bytes] of baked.files) assets.files.set(path, bytes);
    const worker: AppEnv = {
      ...env,
      CF_VERSION: { id: 'grants-worker', tag: '', timestamp: '9999-01-01T00:00:00Z' },
    };
    const racing = raceBefore(
      RACE_TEMPLATE_RELEASE_INSERT,
      async () => {
        await run(env.DB, "UPDATE orgs SET name = name || ' renamed' WHERE id = ?", [org.id]);
        await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [otherOrg.id]);
      },
      worker,
    );
    resetBakedSync();
    await syncBakedTemplates(
      createServiceContext(racing, { clock }),
      sourceOf([baked], 'grants-baked-sync'),
    );
    const releases = await all<{ org_id: string | null; mode: string }>(
      env.DB,
      "SELECT org_id, mode FROM template_releases WHERE template_id = ? AND source = 'system' ORDER BY mode",
      [baked.template.id],
    );
    expect(releases).toEqual([
      { org_id: org.id, mode: 'live' },
      { org_id: org.id, mode: 'test' },
    ]);
  });
});

describe('release impact, restore and platform counts', () => {
  it('counts the org’s passes per mode and diffs against the current release', async () => {
    const { t, c, a } = await reviewed('Impact Card');
    expect((await post(`/${t.templateId}/releases`, publishBody(c, a.id), publisher)).status).toBe(
      201,
    );
    const second = await importZip(env, clock, {
      orgId: org.id,
      createdBy: author.userId,
      name: 'Impact Card',
      zip: zipOf(
        basicPackage(
          {
            'wallet.template.json': JSON.stringify({
              ...manifest('Impact Card'),
              description: 'Changed',
            }),
          },
          { ...passJson(), backgroundColor: 'rgb(1, 2, 3)' },
        ),
      ),
    });
    expect(second.result?.version).toBeDefined();
    const template = await createTemplateRegistry(env).resolve(t.templateId, t.version);
    await makePass(f, { orgId: org.id, template });
    const query = new URLSearchParams({ ...scope(), version: second.result?.version ?? '' });
    const res = await request(`/${t.templateId}/releases/impact?${query}`, publisher);
    expect(res.status).toBe(200);
    const impact = TemplateReleaseImpactSchema.parse(await res.json());
    expect(impact).toMatchObject({ fromVersion: t.version, toVersion: second.result?.version });
    expect(impact.passes).toEqual({ count: 1, capped: false });
    expect(impact.diff.colors).toMatchObject([{ label: 'Background', to: 'rgb(1, 2, 3)' }]);
    const foreign = await member(otherOrg.id, ['template_publisher']);
    await expectProblem(
      await request(`/${t.templateId}/releases/impact?${query}`, foreign),
      404,
      'TEMPLATE_NOT_FOUND',
    );
  });

  it('shows platform pass counts for shared templates to a platform admin', async () => {
    const t = await uploaded('Shared Counted');
    const platform = await member(org.id, ['org_admin'], true);
    await run(env.DB, 'UPDATE templates SET org_id = NULL, shared = 1 WHERE id = ?', [
      t.templateId,
    ]);
    const template = await createTemplateRegistry(env).resolve(t.templateId, t.version);
    await makePass(f, { orgId: org.id, template });
    await makePass(f, { orgId: otherOrg.id, template });
    const list = TemplateListSchema.parse(await (await request('', platform)).json());
    expect(list.items.find((i) => i.id === t.templateId)?.passCount).toBe(2);
  });

  it('restores an archived shared template through a platform admin only', async () => {
    const t = await uploaded('Shared Restore');
    const platform = await member(org.id, ['org_admin'], true);
    await run(env.DB, 'UPDATE templates SET org_id = NULL, shared = 1 WHERE id = ?', [
      t.templateId,
    ]);
    expect((await post(`/${t.templateId}/archive`, {}, platform)).status).toBe(200);
    expect((await post(`/${t.templateId}/restore`, {}, publisher)).status).toBeGreaterThanOrEqual(
      403,
    );
    expect((await post(`/${t.templateId}/restore`, {}, platform)).status).toBe(200);
    expect(
      await first(env.DB, 'SELECT status FROM templates WHERE id = ?', [t.templateId]),
    ).toEqual({ status: 'active' });
  });
});

/** Calls the writers directly with a crafted request, past loadTemplate and the service's JS checks. */
describe('grant-level refusals', () => {
  const ctx = () => createServiceContext(env, { clock });
  const authorityOf = async (
    actor: Actor,
    orgId: string,
    capability: 'templates:author' | 'templates:review' | 'templates:publish',
  ) => {
    const resolved = await createSessionStore(env, clock).resolve(actor.cookie);
    if (!resolved) throw new Error('Session did not resolve');
    return authorizeTemplateWrite(ctx(), resolved, orgId, capability);
  };
  const approvalFor = (c: { id: string; candidateHash: string }, reviewerId: string) => ({
    id: f.ids.id(),
    candidateId: c.id,
    candidateHash: c.candidateHash,
    reviewerId,
    kind: 'peer' as const,
    createdAt: clock.now(),
  });
  const approvals = (candidateId: string) =>
    all(env.DB, 'SELECT id FROM template_approvals WHERE candidate_id = ?', [candidateId]);

  it('refuses an approval from a member of another org', async () => {
    const t = await uploaded('Foreign Approval');
    const c = await candidateOf(t.templateId, t.version);
    const stranger = await member(otherOrg.id, ['template_reviewer']);
    const row = await getCandidate(env.DB, c.id);
    if (!row) throw new Error('Candidate missing');
    await expect(
      writeApproval(
        ctx(),
        await authorityOf(stranger, otherOrg.id, 'templates:review'),
        approvalFor(c, stranger.userId),
        row,
        null,
        {},
      ),
      // The audit row names the candidate's org, which is not the grant's: refused before the lineage check.
    ).rejects.toMatchObject({ status: 403, code: 'ORG_ACCESS_CHANGED' });
    expect(await approvals(c.id)).toEqual([]);
  });

  it('refuses an approval whose reviewer is not the principal’s user', async () => {
    const t = await uploaded('Other Reviewer');
    const c = await candidateOf(t.templateId, t.version);
    const row = await getCandidate(env.DB, c.id);
    if (!row) throw new Error('Candidate missing');
    await expect(
      writeApproval(
        ctx(),
        await authorityOf(reviewer, org.id, 'templates:review'),
        approvalFor(c, publisher.userId),
        row,
        null,
        {},
      ),
    ).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await approvals(c.id)).toEqual([]);
  });

  it('refuses a self-approval that skips the service check', async () => {
    const both = await member(org.id, ['template_author', 'template_reviewer']);
    const t = await uploaded('Grant Self Review', both);
    const c = await candidateOf(t.templateId, t.version, both);
    const row = await getCandidate(env.DB, c.id);
    if (!row) throw new Error('Candidate missing');
    await expect(
      writeApproval(
        ctx(),
        await authorityOf(both, org.id, 'templates:review'),
        approvalFor(c, both.userId),
        row,
        null,
        {},
      ),
    ).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await approvals(c.id)).toEqual([]);
  });

  it('checks the head of an archived template on a rollback', async () => {
    const { t, c, a } = await reviewed('Archived Head Check');
    const published = await post(`/${t.templateId}/releases`, publishBody(c, a.id), publisher);
    expect(published.status).toBe(201);
    const live = (await published.json()) as { id: string };
    expect((await post(`/${t.templateId}/archive`, {}, publisher)).status).toBe(200);
    const row = await getCandidate(env.DB, c.id);
    if (!row) throw new Error('Candidate missing');
    const grantee = await authorityOf(publisher, org.id, 'templates:publish');
    const rollback = (expectedReleaseId: string) =>
      writeRelease(
        ctx(),
        grantee,
        {
          id: f.ids.id(),
          candidate: row,
          approvalId: a.id,
          expectedGeneration: 1,
          expectedReleaseId,
          targetReleaseId: live.id,
          action: 'rollback',
          expectedStatus: 'archived',
          createdBy: publisher.userId,
          createdAt: clock.now(),
          metadata: null,
        },
        {},
      );
    await expect(rollback(f.ids.id())).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_RELEASE_CONFLICT',
    });
    expect(await releaseCount(t.templateId)).toBe(1);
    await rollback(live.id);
    expect(await releaseCount(t.templateId)).toBe(2);
  });

  it('refuses a member grant on a shared template', async () => {
    const t = await uploaded('Shared Archive');
    await run(env.DB, 'UPDATE templates SET org_id = NULL, shared = 1 WHERE id = ?', [
      t.templateId,
    ]);
    const row = await getTemplate(env.DB, t.templateId);
    if (!row) throw new Error('Template missing');
    const grantee = await authorityOf(publisher, org.id, 'templates:publish');
    expect(await archiveUploadedTemplate(ctx(), row, grantee, clock.now())).toBe(false);
    expect(
      await first(env.DB, 'SELECT status FROM templates WHERE id = ?', [t.templateId]),
    ).toEqual({
      status: 'active',
    });
  });
});

describe('baked sync grant', () => {
  it('gives a route context no system grant, and only the fixed purpose', async () => {
    expect(Object.keys(templateSyncModule).sort()).toEqual(['SYNC_CONFLICT', 'templateSyncGrant']);
    const route = createServiceContext(env, { clock });
    expect(() =>
      jobGrant(route, { job: 'x', purpose: 'platform.job.anything', checks: [] }),
    ).toThrow(/jobGrant/);
    const g = templateSyncGrant(route, []);
    expect(g.purpose).toBe('platform.job.template_sync');
    expect(g.principal).toMatchObject({ kind: 'system', job: 'template-sync' });
  });

  it('serves the database as it is under persistent contention, and backs off', async () => {
    const baked = await bakedFrom('grants-contended', basicPackage(), {
      name: 'Grants Contended',
      org: { slug: org.slug, name: org.name },
    });
    for (const [path, bytes] of baked.files) assets.files.set(path, bytes);
    const worker: AppEnv = {
      ...env,
      CF_VERSION: { id: 'contended-worker', tag: '', timestamp: '9999-02-01T00:00:00Z' },
    };
    let contended = true;
    const racing = raceBefore(
      RACE_TEMPLATE_RELEASE_INSERT,
      () =>
        contended
          ? run(
              env.DB,
              "UPDATE settings SET value = value || ' ' WHERE key = 'templates.baked_adoption'",
            )
          : Promise.resolve(),
      worker,
      { always: true },
    );
    const source = sourceOf([baked], 'grants-contended-sync');
    resetBakedSync();
    await expect(
      syncBakedTemplates(createServiceContext(racing, { clock }), source),
    ).resolves.toBeUndefined();
    const count = () =>
      first<{ n: number }>(
        env.DB,
        'SELECT COUNT(*) AS n FROM template_releases WHERE template_id = ?',
        [baked.template.id],
      );
    expect(await count()).toEqual({ n: 0 });
    // Within the back-off window the next read does not sync again, though nothing contends any more.
    contended = false;
    await syncBakedTemplates(createServiceContext(racing, { clock }), source);
    expect(await count()).toEqual({ n: 0 });
  });
});

describe('restore without an approved Live head', () => {
  const restore = (id: string, actor: Actor) => post(`/${id}/restore`, {}, actor);
  const archive = (id: string, actor: Actor) => post(`/${id}/archive`, {}, actor);
  const status = (id: string) => first(env.DB, 'SELECT status FROM templates WHERE id = ?', [id]);
  const legacy = (id: string, version: string, mode: 'live' | 'test') =>
    run(
      env.DB,
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version,
         candidate_hash, content_hash, adapter_revision, adapter_capabilities,
         audience_policy_revision, source, action, created_at)
       VALUES (?, ?, ?, ?, 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'legacy', 'legacy', ?)`,
      [f.ids.id(), id, org.id, mode, version, 'a'.repeat(64), 'b'.repeat(64), clock.now()],
    );

  it('restores a template whose only history is a candidate', async () => {
    const t = await uploaded('Candidate Only Restore');
    await candidateOf(t.templateId, t.version);
    expect((await archive(t.templateId, publisher)).status).toBe(200);
    expect((await restore(t.templateId, publisher)).status).toBe(200);
    expect(await status(t.templateId)).toEqual({ status: 'active' });
  });

  it('restores a template whose only history is in Test mode', async () => {
    const t = await uploaded('Test Only Restore');
    const res = await app.request(
      `${ORIGIN}/api/v1/templates/${t.templateId}/candidates`,
      {
        method: 'POST',
        headers: {
          ...author.headers,
          'content-type': 'application/json',
          'x-passbook-mode': 'test',
        },
        body: JSON.stringify({ ...scope(), mode: 'test', version: t.version }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect((await archive(t.templateId, publisher)).status).toBe(200);
    expect((await restore(t.templateId, publisher)).status).toBe(200);
  });

  it('restores a template whose Live head is a legacy release', async () => {
    const t = await uploaded('Legacy Head Restore');
    await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      t.version,
      t.templateId,
    ]);
    await legacy(t.templateId, t.version, 'live');
    expect((await archive(t.templateId, publisher)).status).toBe(200);
    const detail = await (await request(`/${t.templateId}`, publisher)).json();
    expect(detail).toMatchObject({ status: 'archived', restorable: true });
    expect((await restore(t.templateId, publisher)).status).toBe(200);
  });

  it('keeps an approved Live head restorable only by rollback', async () => {
    const { t, c, a } = await reviewed('Approved Head Restore');
    expect((await post(`/${t.templateId}/releases`, publishBody(c, a.id), publisher)).status).toBe(
      201,
    );
    expect((await archive(t.templateId, publisher)).status).toBe(200);
    const res = await restore(t.templateId, publisher);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
  });

  it('lets a platform admin restore a shared template that has an org’s history', async () => {
    const t = await uploaded('Shared History Restore');
    await candidateOf(t.templateId, t.version);
    await run(env.DB, 'UPDATE templates SET org_id = NULL, shared = 1 WHERE id = ?', [
      t.templateId,
    ]);
    const admin = await member(org.id, ['org_admin'], true);
    expect((await archive(t.templateId, admin)).status).toBe(200);
    const detail = await (await request(`/${t.templateId}`, admin)).json();
    expect(detail).toMatchObject({ restorable: true });
    expect((await restore(t.templateId, admin)).status).toBe(200);
    expect(await status(t.templateId)).toEqual({ status: 'active' });
  });
});

describe('moving a template', () => {
  it('lets a platform admin who belongs to neither org move a shared template', async () => {
    const t = await uploaded('Admin Moves');
    await run(env.DB, 'UPDATE templates SET org_id = NULL, shared = 1 WHERE id = ?', [
      t.templateId,
    ]);
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
    const outsider: Actor = {
      userId: user.id,
      membershipId: '',
      cookie: session.cookieValue,
      headers: session.headers,
    };
    const res = await request(`/${t.templateId}`, outsider, {
      method: 'PATCH',
      body: JSON.stringify({ orgId: otherOrg.id }),
    });
    expect(res.status).toBe(200);
    expect(
      await first(env.DB, 'SELECT org_id FROM templates WHERE id = ?', [t.templateId]),
    ).toEqual({
      org_id: otherOrg.id,
    });
  });

  it('refuses a move to a suspended org', async () => {
    const t = await uploaded('Admin Moves Suspended');
    await run(env.DB, 'UPDATE templates SET org_id = NULL, shared = 1 WHERE id = ?', [
      t.templateId,
    ]);
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [otherOrg.id]);
    const admin = await member(org.id, ['org_admin'], true);
    const res = await request(`/${t.templateId}`, admin, {
      method: 'PATCH',
      body: JSON.stringify({ orgId: otherOrg.id }),
    });
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(
      await first(env.DB, 'SELECT org_id FROM templates WHERE id = ?', [t.templateId]),
    ).toEqual({
      org_id: null,
    });
  });

  it('refuses a move while an event still uses the template', async () => {
    const t = await uploaded('Admin Moves Referenced');
    await makeScanEvent(f, { orgId: org.id, mode: 'live', templateIds: [t.templateId] });
    const admin = await member(org.id, ['org_admin'], true);
    const res = await request(`/${t.templateId}`, admin, {
      method: 'PATCH',
      body: JSON.stringify({ orgId: otherOrg.id }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_IN_USE' });
    expect(
      await first(env.DB, 'SELECT org_id FROM templates WHERE id = ?', [t.templateId]),
    ).toEqual({
      org_id: org.id,
    });
  });
});

describe('rollout and impact', () => {
  async function released(name: string) {
    const { t, c, a } = await reviewed(name);
    expect((await post(`/${t.templateId}/releases`, publishBody(c, a.id), publisher)).status).toBe(
      201,
    );
    return t;
  }
  const secondVersion = (name: string, orgId = org.id) =>
    importZip(env, clock, {
      orgId,
      createdBy: author.userId,
      name,
      zip: zipOf(
        basicPackage(
          { 'wallet.template.json': JSON.stringify({ ...manifest(name), description: 'Two' }) },
          { ...passJson(), backgroundColor: 'rgb(4, 5, 6)' },
        ),
      ),
    });
  const rollout = async (
    id: string,
    actor: Pick<Actor, 'headers'>,
    query: Record<string, string> = {},
  ) => {
    const q = new URLSearchParams({ orgId: org.id, mode: 'live', ...query });
    return request(`/${id}/rollout?${q}`, actor as Actor);
  };
  const read = async (id: string, actor: Pick<Actor, 'headers'> = publisher) =>
    TemplateRolloutSchema.parse(await (await rollout(id, actor)).json());
  const releaseOf = async (templateId: string, mode = 'live') =>
    (
      await first<{ id: string }>(
        env.DB,
        'SELECT id FROM template_releases WHERE template_id = ? AND mode = ? ORDER BY generation DESC',
        [templateId, mode],
      )
    )?.id ?? '';
  /** A bulk reissue that carries the release, as the cron starts one. */
  async function rebuild(
    templateId: string,
    instance: string,
    status: string,
    options: { mode?: string; releaseId?: string } = {},
  ) {
    const mode = options.mode ?? 'live';
    await run(
      env.DB,
      `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
       VALUES (?, 'bulk_reissue', ?, ?, ?, ?)`,
      [instance, org.id, templateId, status, clock.now() + 1],
    );
    await run(env.DB, 'INSERT INTO workflow_release_snapshot_sets (instance_id) VALUES (?)', [
      instance,
    ]);
    const release = await first<{ id: string; generation: number; version: string }>(
      env.DB,
      'SELECT id, generation, version FROM template_releases WHERE id = ?',
      [options.releaseId ?? (await releaseOf(templateId, mode))],
    );
    await run(
      env.DB,
      `INSERT INTO workflow_release_snapshots (instance_id, org_id, mode, template_id, release_id, generation, version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [instance, org.id, mode, templateId, release?.id, release?.generation, release?.version],
    );
  }
  /** A key stands for the org; its scopes are the only thing that varies. */
  const key = (scopes: string[], orgId = org.id) =>
    ({ headers: auth.apiKey({ orgId, scopes: scopes as never }) }) satisfies Pick<Actor, 'headers'>;

  it('reports progress, leftovers after the rebuild, and nothing from other orgs', async () => {
    const t = await released('Rollout Card');
    const registry = createTemplateRegistry(env);
    const onRelease = await registry.resolve(t.templateId, t.version);
    await makePass(f, { orgId: org.id, template: onRelease });
    const second = await secondVersion('Rollout Card');
    const old = await registry.resolve(t.templateId, second.result?.version ?? '');
    const behind = await makePass(f, { orgId: org.id, template: old });
    await makePass(f, { orgId: otherOrg.id, template: old });
    const reader = await member(org.id, ['org_admin']);
    const before = await read(t.templateId, reader);
    expect(before).toMatchObject({
      releaseVersion: t.version,
      total: 2,
      onRelease: 1,
      remaining: 1,
      running: false,
      failed: [],
      failedCount: 0,
      runId: null,
      stalled: false,
    });
    expect(before.updating).toEqual([{ version: old.version, count: 1 }]);

    await rebuild(t.templateId, 'run-open', 'running');
    expect(await read(t.templateId, reader)).toMatchObject({
      running: true,
      failed: [],
      remaining: 1,
    });
    await run(
      env.DB,
      "UPDATE workflow_runs SET status = 'complete' WHERE instance_id = 'run-open'",
    );
    const after = await read(t.templateId, reader);
    expect(after).toMatchObject({
      running: false,
      runId: 'run-open',
      failedCount: 1,
      updating: [],
    });
    expect(after.failed.map((p) => p.passId)).toEqual([behind.id]);
    expect(after.failed[0]?.reason).toBe('Not moved by the last rebuild.');
    expect(after.changes).toBeDefined();

    await run(env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [behind.id]);
    expect(await read(t.templateId, reader)).toMatchObject({ total: 1, remaining: 0, failed: [] });
  });

  it('ignores a rebuild in the other mode or for another release', async () => {
    const t = await released('Rollout Modes');
    const second = await secondVersion('Rollout Modes');
    const old = await createTemplateRegistry(env).resolve(
      t.templateId,
      second.result?.version ?? '',
    );
    await makePass(f, { orgId: org.id, template: old });
    // A finished run that carries this release in Test mode says nothing about Live.
    await rebuild(t.templateId, 'run-test', 'complete', {
      mode: 'test',
      releaseId: await releaseOf(t.templateId),
    });
    const body = await read(t.templateId, await member(org.id, ['org_admin']));
    expect(body).toMatchObject({ runId: null, running: false, failedCount: 0, remaining: 1 });
  });

  it('treats a rollout that never started as stalled after the grace period', async () => {
    const t = await released('Rollout Stalled');
    const second = await secondVersion('Rollout Stalled');
    const old = await createTemplateRegistry(env).resolve(
      t.templateId,
      second.result?.version ?? '',
    );
    await makePass(f, { orgId: org.id, template: old });
    expect(await read(t.templateId)).toMatchObject({ stalled: false, failedCount: 0 });
    const now = clock.now();
    clock.set(now + 12 * 60_000);
    try {
      const later = await member(org.id, ['template_publisher']);
      const stalled = await read(t.templateId, await member(org.id, ['org_admin']));
      expect(stalled).toMatchObject({ stalled: true, failedCount: 1, updating: [] });
      expect(stalled.failed[0]?.reason).toBe('No rebuild ran for this release.');
      expect(later).toBeDefined();
    } finally {
      clock.set(now);
    }
  });

  it('shows the recorded reason before any rebuild has finished', async () => {
    const t = await released('Rollout Reason');
    const second = await secondVersion('Rollout Reason');
    const old = await createTemplateRegistry(env).resolve(
      t.templateId,
      second.result?.version ?? '',
    );
    const behind = await makePass(f, { orgId: org.id, template: old });
    await recordRolloutFailure(env.DB, {
      passId: behind.id,
      orgId: org.id,
      mode: 'live',
      templateId: t.templateId,
      releaseId: await releaseOf(t.templateId),
      code: 'STAMPS_ABOVE_MAX',
      message: 'The card holds more stamps than the new version allows.',
      at: clock.now(),
    });
    const body = await read(t.templateId, await member(org.id, ['org_admin']));
    expect(body).toMatchObject({ failedCount: 1, remaining: 1, running: false, updating: [] });
    expect(body.failed).toEqual([
      { passId: behind.id, title: null, reason: expect.stringContaining('more stamps') },
    ]);
    // The row belongs to that pass in that org: another org's pass id records nothing.
    await recordRolloutFailure(env.DB, {
      passId: behind.id,
      orgId: otherOrg.id,
      mode: 'live',
      templateId: t.templateId,
      releaseId: 'r',
      code: 'X',
      message: 'x',
      at: 1,
    });
    expect(
      await all(env.DB, 'SELECT code FROM template_rollout_failures WHERE pass_id = ?', [
        behind.id,
      ]),
    ).toEqual([{ code: 'STAMPS_ABOVE_MAX' }]);
  });

  it('lists passes only to a caller who can read passes, for sessions and keys alike', async () => {
    const t = await released('Rollout Visibility');
    const second = await secondVersion('Rollout Visibility');
    const old = await createTemplateRegistry(env).resolve(
      t.templateId,
      second.result?.version ?? '',
    );
    const behind = await makePass(f, { orgId: org.id, template: old });
    await recordRolloutFailure(env.DB, {
      passId: behind.id,
      orgId: org.id,
      mode: 'live',
      templateId: t.templateId,
      releaseId: await releaseOf(t.templateId),
      code: 'X',
      message: 'Left behind.',
      at: clock.now(),
    });
    // A publisher reads templates, not passes: the count, never the list.
    expect(await read(t.templateId, publisher)).toMatchObject({ failedCount: 1, failed: [] });
    expect((await read(t.templateId, await member(org.id, ['org_admin']))).failed).toHaveLength(1);
    expect(await read(t.templateId, key(['templates:read']))).toMatchObject({
      failedCount: 1,
      failed: [],
    });
    expect((await read(t.templateId, key(['templates:read', 'passes:read']))).failed).toHaveLength(
      1,
    );
    // Parity with the session rules: another org is not found, no templates:read is forbidden.
    await expectProblem(
      await rollout(t.templateId, key(['templates:read'], otherOrg.id)),
      403,
      'ORG_FORBIDDEN',
    );
    expect((await rollout(t.templateId, key(['passes:read']))).status).toBe(403);
  });

  it('counts an older version on an equivalent build, and not a quarantined pass, as done', async () => {
    const t = await released('Rollout Equivalent');
    const second = await secondVersion('Rollout Equivalent');
    const registry = createTemplateRegistry(env);
    const old = await registry.resolve(t.templateId, second.result?.version ?? '');
    const same = await makePass(f, { orgId: org.id, template: old });
    const quarantined = await makePass(f, { orgId: org.id, template: old });
    await run(env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [quarantined.id]);
    expect(await read(t.templateId)).toMatchObject({ total: 1, remaining: 1 });
    await withoutTrigger(env.DB, 'template_versions_immutable', () =>
      run(
        env.DB,
        `UPDATE template_versions SET build_key = 'same' WHERE template_id = ? AND version IN (?, ?)`,
        [t.templateId, t.version, old.version],
      ),
    );
    expect(same.id).not.toBe(quarantined.id);
    expect(await read(t.templateId)).toMatchObject({ total: 1, onRelease: 1, remaining: 0 });
  });

  it('offers one message per release, to whoever is on it, and a text that fits a rollback', async () => {
    const t = await released('Rollout Tell');
    const registry = createTemplateRegistry(env);
    const second = await secondVersion('Rollout Tell');
    const old = await registry.resolve(t.templateId, second.result?.version ?? '');
    const onRelease = await registry.resolve(t.templateId, t.version);
    const releaseId = await releaseOf(t.templateId);
    const behind = await makePass(f, { orgId: org.id, template: old });
    expect((await read(t.templateId)).tell).toBeNull();
    await makePass(f, { orgId: org.id, template: onRelease });
    const offered = (await read(t.templateId)).tell;
    expect(offered).toMatchObject({
      key: `rollout-tell:${releaseId}`,
      text: 'Rollout Tell has a new design.',
    });
    await run(env.DB, 'UPDATE passes SET template_version = ? WHERE id = ?', [
      t.version,
      behind.id,
    ]);
    expect((await read(t.templateId)).tell).not.toBeNull();
    // Sent once: the idempotency row the message create leaves hides the offer for good.
    await run(
      env.DB,
      `INSERT INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at)
       VALUES (?, ?, 'h', 'done:{}', ?)`,
      [org.id, `broadcast-create:live:rollout-tell:${releaseId}`, clock.now()],
    );
    expect((await read(t.templateId)).tell).toBeNull();
    await run(env.DB, 'DELETE FROM idempotency_keys WHERE org_id = ?', [org.id]);
    expect((await read(t.templateId)).tell).not.toBeNull();
    // A day later the offer is over.
    const now = clock.now();
    clock.set(now + 25 * 3_600_000);
    try {
      const later = await member(org.id, ['template_publisher']);
      expect((await read(t.templateId, later)).tell).toBeNull();
    } finally {
      clock.set(now);
    }
  });

  it('refuses another org and another mode', async () => {
    const t = await released('Rollout Scope');
    const foreign = await member(otherOrg.id, ['template_publisher']);
    await expectProblem(await rollout(t.templateId, foreign), 404, 'TEMPLATE_NOT_FOUND');
    await expectProblem(
      await rollout(t.templateId, publisher, { mode: 'test' }),
      403,
      'TEMPLATE_MODE_MISMATCH',
    );
  });

  it('counts only the active passes the cron would move', async () => {
    const t = await released('Impact Moves');
    const second = await secondVersion('Impact Moves');
    const registry = createTemplateRegistry(env);
    const old = await registry.resolve(t.templateId, t.version);
    const voided = await makePass(f, { orgId: org.id, template: old });
    await makePass(f, { orgId: org.id, template: old });
    await run(env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    const query = new URLSearchParams({ ...scope(), version: second.result?.version ?? '' });
    const impact = TemplateReleaseImpactSchema.parse(
      await (await request(`/${t.templateId}/releases/impact?${query}`, publisher)).json(),
    );
    expect(impact.passes).toEqual({ count: 1, capped: false });
  });
});

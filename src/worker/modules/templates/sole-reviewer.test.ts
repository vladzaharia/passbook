import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import sql from '../../../../migrations/0093_template_sole_approval.sql?raw';
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
  TemplateApprovalSchema,
  TemplateCandidateSchema,
  TemplateReleaseListSchema,
  TemplateReleaseSchema,
} from '../../../shared/contracts/template-releases.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { basicPackage, passJson, zipOf } from './package/fixtures.ts';
import { REVIEW_ROLES, SOLE_COOLDOWN_MS } from './repo-sole-reviewer.ts';
import { fakeAssets, importZip, watchBatch } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
const watchers: (() => number)[] = [];

interface Actor {
  userId: string;
  membershipId: string;
  headers: Record<string, string>;
}

async function member(orgId: string, roles: OrgRole[]): Promise<Actor> {
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
  const session = await makeSession(f, { userId: user.id, roles: ['user'] });
  return { userId: user.id, membershipId, headers: session.headers };
}

const scope = (orgId: string, mode: Mode = 'live') => ({ orgId, mode, provider: 'apple' }) as const;
const post = (path: string, body: unknown, actor: Actor, mode: Mode = 'live', e: AppEnv = env) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    {
      method: 'POST',
      headers: {
        ...actor.headers,
        'content-type': 'application/json',
        ...(mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
      },
      body: JSON.stringify(body),
    },
    e,
  );
const get = (path: string, actor: Actor, mode: Mode = 'live') =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    {
      headers: { ...actor.headers, ...(mode === 'test' ? { 'x-passbook-mode': 'test' } : {}) },
    },
    env,
  );

const manifest = (name: string) => ({
  schema: 1,
  name,
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
});

async function uploaded(name: string, org: OrgRow, by: Actor) {
  const result = await importZip(env, clock, {
    orgId: org.id,
    createdBy: by.userId,
    name,
    zip: zipOf(
      basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)) }, passJson()),
    ),
  });
  if (!result.result) throw new Error('Import failed');
  return result.result;
}

async function candidateOf(org: OrgRow, id: string, version: string, by: Actor, mode?: Mode) {
  const res = await post(`/${id}/candidates`, { ...scope(org.id, mode), version }, by, mode);
  expect(res.status).toBe(201);
  return TemplateCandidateSchema.parse(await res.json());
}

const approve = (
  org: OrgRow,
  id: string,
  c: { id: string; candidateHash: string },
  by: Actor,
  extra: { alone?: boolean; mode?: Mode } = {},
  e: AppEnv = env,
) =>
  post(
    `/${id}/candidates/${c.id}/approve`,
    {
      ...scope(org.id, extra.mode),
      candidateHash: c.candidateHash,
      ...(extra.alone === undefined ? {} : { alone: extra.alone }),
    },
    by,
    extra.mode,
    e,
  );

const approvalRows = (candidateId: string) =>
  all<{ kind: string }>(env.DB, 'SELECT kind FROM template_approvals WHERE candidate_id = ?', [
    candidateId,
  ]);

/** An org whose only reviewer is its owner, who also authors. */
async function soloOrg(name: string) {
  const org = await makeOrg(f);
  const owner = await member(org.id, ['org_admin']);
  const t = await uploaded(name, org, owner);
  const c = await candidateOf(org, t.templateId, t.version, owner);
  return { org, owner, t, c };
}

beforeAll(async () => {
  clock = new ManualClock();
  env = await makeEnv({
    ASSETS: fakeAssets(),
    CF_VERSION: { id: 'default-worker', tag: '', timestamp: '9990-01-01T00:00:00Z' },
  });
  f = fixtures(env, clock);
  app = createApp({ stores: { ...auth.stores, sessions: createSessionStore(env, clock) }, clock });
});

afterEach(() => {
  expect(watchers.splice(0).every((fired) => fired() > 0)).toBe(true);
});

describe('sole-reviewer approval', () => {
  it('lets the only reviewer approve and publish their own version, audited', async () => {
    const { org, owner, t, c } = await soloOrg('Sole Approval');
    await expectProblem(await approve(org, t.templateId, c, owner), 403, 'TEMPLATE_SELF_APPROVAL');
    expect(await approvalRows(c.id)).toEqual([]);

    const res = await approve(org, t.templateId, c, owner, { alone: true });
    expect(res.status).toBe(201);
    const a = TemplateApprovalSchema.parse(await res.json());
    expect(a).toMatchObject({ kind: 'sole', reviewerId: owner.userId });
    expect(await approvalRows(c.id)).toEqual([{ kind: 'sole' }]);

    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'template.approved_alone'",
      [t.templateId],
    );
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ kind: 'sole', candidateId: c.id });

    const released = await post(
      `/${t.templateId}/releases`,
      {
        ...scope(org.id),
        candidateId: c.id,
        approvalId: a.id,
        candidateHash: c.candidateHash,
        expectedGeneration: 0,
      },
      owner,
    );
    expect(released.status).toBe(201);
    expect(TemplateReleaseSchema.parse(await released.json())).toMatchObject({
      version: t.version,
      approvalId: a.id,
    });
    const list = TemplateReleaseListSchema.parse(
      await (
        await get(`/${t.templateId}/releases?${new URLSearchParams(scope(org.id))}`, owner)
      ).json(),
    );
    expect(list.active?.approvalId).toBe(a.id);
    const listed = await get(
      `/${t.templateId}/candidates?${new URLSearchParams(scope(org.id))}`,
      owner,
    );
    const body = (await listed.json()) as { items: { approvals: { kind: string }[] }[] };
    expect(body.items[0]?.approvals[0]?.kind).toBe('sole');
  });

  it('is refused when the org has a second reviewer', async () => {
    const { org, owner, t, c } = await soloOrg('Two Reviewers');
    await member(org.id, ['template_reviewer']);
    await expectProblem(
      await approve(org, t.templateId, c, owner, { alone: true }),
      403,
      'TEMPLATE_SELF_APPROVAL',
    );
    expect(await approvalRows(c.id)).toEqual([]);
  });

  it('is refused for 7 days after a reviewer is removed, then allowed', async () => {
    const removeAt = async (org: OrgRow, at: number) => {
      const leaving = await member(org.id, ['template_reviewer']);
      await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
        at,
        leaving.membershipId,
      ]);
    };
    const recent = await soloOrg('Removed Reviewer');
    await removeAt(recent.org, clock.now() - SOLE_COOLDOWN_MS + 1000);
    const denied = await approve(recent.org, recent.t.templateId, recent.c, recent.owner, {
      alone: true,
    });
    await expectProblem(denied, 403, 'TEMPLATE_SELF_APPROVAL');
    expect(await approvalRows(recent.c.id)).toEqual([]);

    const old = await soloOrg('Removed Long Ago');
    await removeAt(old.org, clock.now() - SOLE_COOLDOWN_MS - 1000);
    const res = await approve(old.org, old.t.templateId, old.c, old.owner, { alone: true });
    expect(res.status).toBe(201);
  });

  it('refuses when a second reviewer joins while the approval commits', async () => {
    const { org, owner, t, c } = await soloOrg('Reviewer Race');
    const raced = watchBatch(env, /INSERT INTO template_approvals/, () =>
      member(org.id, ['template_reviewer']),
    );
    watchers.push(raced.fired);
    const res = await approve(org, t.templateId, c, owner, { alone: true }, raced.env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await approvalRows(c.id)).toEqual([]);
  });

  it('keeps a peer approval independent', async () => {
    const { org, owner, t, c } = await soloOrg('Peer Approval');
    const peer = await member(org.id, ['template_reviewer']);
    const res = await approve(org, t.templateId, c, peer);
    expect(TemplateApprovalSchema.parse(await res.json()).kind).toBe('peer');
    // A second reviewer exists now, and the owner is still refused.
    await expectProblem(
      await approve(org, t.templateId, c, owner, { alone: true }),
      403,
      'TEMPLATE_SELF_APPROVAL',
    );
  });

  it('refuses to publish a sole approval after another reviewer joined', async () => {
    const { org, owner, t, c } = await soloOrg('Banked Approval');
    const a = TemplateApprovalSchema.parse(
      await (await approve(org, t.templateId, c, owner, { alone: true })).json(),
    );
    clock.advance(1000);
    await member(org.id, ['template_reviewer']);
    const released = await post(
      `/${t.templateId}/releases`,
      {
        ...scope(org.id),
        candidateId: c.id,
        approvalId: a.id,
        candidateHash: c.candidateHash,
        expectedGeneration: 0,
      },
      owner,
    );
    expect(released.status).toBe(409);
    expect(
      await first(env.DB, 'SELECT id FROM template_releases WHERE template_id = ?', [t.templateId]),
    ).toBeNull();
  });

  it('voids a sole approval when a long-standing author is promoted to reviewer', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const author = await member(org.id, ['template_author']);
    const t = await uploaded('Promoted Author', org, owner);
    const c = await candidateOf(org, t.templateId, t.version, owner);
    clock.advance(1000);
    const a = TemplateApprovalSchema.parse(
      await (await approve(org, t.templateId, c, owner, { alone: true })).json(),
    );
    clock.advance(1000);
    const promoted = await app.request(
      `${ORIGIN}/api/v1/orgs/${org.id}/memberships/${author.membershipId}`,
      {
        method: 'PATCH',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ roles: ['template_reviewer'] }),
      },
      env,
    );
    expect(promoted.status).toBe(200);
    const released = await post(
      `/${t.templateId}/releases`,
      {
        ...scope(org.id),
        candidateId: c.id,
        approvalId: a.id,
        candidateHash: c.candidateHash,
        expectedGeneration: 0,
      },
      owner,
    );
    expect(released.status).toBe(409);
    expect(
      await first(env.DB, 'SELECT id FROM template_releases WHERE template_id = ?', [t.templateId]),
    ).toBeNull();
  });

  it('keeps the trigger role list equal to the roles that grant review', () => {
    const lists = sql.match(/IN \('org_admin'[^)]*\)/g) ?? [];
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) expect(list.slice(3)).toBe(REVIEW_ROLES);
  });

  it('requires an author with review rights for a test row, in the database', async () => {
    const org = await makeOrg(f);
    const author = await member(org.id, ['template_author']);
    const t = await uploaded('Test Row', org, author);
    const c = await candidateOf(org, t.templateId, t.version, author, 'test');
    const stranger = await member(org.id, ['template_reviewer']);
    const insert = (reviewer: string) =>
      run(
        env.DB,
        `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, kind, created_at)
         VALUES (?, ?, ?, ?, 'test', ?)`,
        [f.ids.id(), c.id, c.candidateHash, reviewer, clock.now()],
      );
    await expect(insert(stranger.userId)).rejects.toThrow(/invalid template approval/);
    await expect(insert(author.userId)).rejects.toThrow(/invalid template approval/);
  });

  it('is enforced by the database, not only the service', async () => {
    const { org, owner, c } = await soloOrg('Database Enforced');
    const insert = (id: string, kind: string, reviewer = owner.userId) =>
      run(
        env.DB,
        `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, c.id, c.candidateHash, reviewer, kind, clock.now()],
      );
    await expect(insert(f.ids.id(), 'peer')).rejects.toThrow(/invalid template approval/);
    await expect(insert(f.ids.id(), 'test')).rejects.toThrow(/invalid template approval/);
    await member(org.id, ['org_admin']);
    await expect(insert(f.ids.id(), 'sole')).rejects.toThrow(/invalid template approval/);
    expect(await approvalRows(c.id)).toEqual([]);
  });
});

describe('test-mode approval and promote to Live', () => {
  it('lets the author approve alone in Test in any org, with confirmation', async () => {
    const org = await makeOrg(f);
    const author = await member(org.id, ['template_author', 'template_reviewer']);
    await member(org.id, ['template_reviewer']);
    const t = await uploaded('Test Mode Alone', org, author);
    const c = await candidateOf(org, t.templateId, t.version, author, 'test');
    await expectProblem(
      await approve(org, t.templateId, c, author, { mode: 'test' }),
      403,
      'TEMPLATE_SELF_APPROVAL',
    );
    const res = await approve(org, t.templateId, c, author, { mode: 'test', alone: true });
    expect(res.status).toBe(201);
    expect(TemplateApprovalSchema.parse(await res.json()).kind).toBe('test');
    const audit = await first<{ n: number }>(
      env.DB,
      "SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ? AND action = 'template.approved_alone'",
      [t.templateId],
    );
    expect(audit?.n).toBe(1);
  });

  it('promotes the version released in Test to a Live candidate, the same version', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Promote Same Version', org, owner);
    const path = `/${t.templateId}/candidates/promote`;
    const body = { ...scope(org.id), version: t.version };

    await expectProblem(await post(path, body, owner), 409, 'TEMPLATE_NOT_TESTED');

    const tc = await candidateOf(org, t.templateId, t.version, owner, 'test');
    const ta = TemplateApprovalSchema.parse(
      await (await approve(org, t.templateId, tc, owner, { mode: 'test', alone: true })).json(),
    );
    const released = await post(
      `/${t.templateId}/releases`,
      {
        ...scope(org.id, 'test'),
        candidateId: tc.id,
        approvalId: ta.id,
        candidateHash: tc.candidateHash,
        expectedGeneration: 0,
      },
      owner,
      'test',
    );
    expect(released.status).toBe(201);

    const offered = TemplateReleaseListSchema.parse(
      await (
        await get(`/${t.templateId}/releases?${new URLSearchParams(scope(org.id))}`, owner)
      ).json(),
    );
    expect(offered.promotable).toEqual([t.version]);

    const res = await post(path, body, owner);
    expect(res.status).toBe(201);
    const live = TemplateCandidateSchema.parse(await res.json());
    expect(live).toMatchObject({ mode: 'live', version: t.version, contentHash: tc.contentHash });

    // One review (the sole reviewer's) and Live has the same version.
    const la = TemplateApprovalSchema.parse(
      await (await approve(org, t.templateId, live, owner, { alone: true })).json(),
    );
    const out = await post(
      `/${t.templateId}/releases`,
      {
        ...scope(org.id),
        candidateId: live.id,
        approvalId: la.id,
        candidateHash: live.candidateHash,
        expectedGeneration: 0,
      },
      owner,
    );
    expect(out.status).toBe(201);
    expect(TemplateReleaseSchema.parse(await out.json())).toMatchObject({
      mode: 'live',
      version: t.version,
    });
  });
});

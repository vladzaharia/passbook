import { beforeAll, describe, expect, it } from 'vitest';
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
} from '../../../shared/contracts/template-releases.ts';
import { TemplateDetailSchema } from '../../../shared/contracts/templates.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { basicPackage, passJson, zipOf } from './package/fixtures.ts';
import { fakeAssets, importZip } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;

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
const headersOf = (actor: Actor, mode: Mode) => ({
  ...actor.headers,
  ...(mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
});
const post = (path: string, body: unknown, actor: Actor, mode: Mode = 'live') =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    {
      method: 'POST',
      headers: { ...headersOf(actor, mode), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

async function release(id: string, by: Actor) {
  const res = await app.request(
    `${ORIGIN}/api/v1/templates/${id}`,
    { headers: headersOf(by, 'live') },
    env,
  );
  expect(res.status).toBe(200);
  const state = TemplateDetailSchema.parse(await res.json()).release;
  if (!state) throw new Error('No release state');
  return state;
}

async function uploaded(name: string, org: OrgRow, by: Actor) {
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
    zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest) }, passJson())),
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
  alone?: true,
) =>
  post(
    `/${id}/candidates/${c.id}/approve`,
    { ...scope(org.id), candidateHash: c.candidateHash, ...(alone ? { alone } : {}) },
    by,
  );

async function publish(
  org: OrgRow,
  id: string,
  c: { id: string; candidateHash: string },
  by: Actor,
  approvalId: string,
) {
  const res = await post(
    `/${id}/releases`,
    {
      ...scope(org.id),
      candidateId: c.id,
      approvalId,
      candidateHash: c.candidateHash,
      expectedGeneration: 0,
    },
    by,
  );
  expect(res.status).toBe(201);
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

describe('release state on the template detail', () => {
  it('walks a solo admin from Try to released', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Solo State', org, owner);
    expect(await release(t.templateId, owner)).toMatchObject({
      live: null,
      test: null,
      draft: { version: t.version },
      review: { state: 'none' },
      alone: true,
      next: 'try',
    });
    const c = await candidateOf(org, t.templateId, t.version, owner);
    const a = TemplateApprovalSchema.parse(
      await (await approve(org, t.templateId, c, owner, true)).json(),
    );
    await publish(org, t.templateId, c, owner, a.id);
    expect(await release(t.templateId, owner)).toMatchObject({
      live: { version: t.version },
      test: null,
      draft: null,
      next: null,
    });
  });

  it('routes a team through request, review and release', async () => {
    const org = await makeOrg(f);
    const author = await member(org.id, ['template_author']);
    const reviewer = await member(org.id, ['template_reviewer']);
    const publisher = await member(org.id, ['template_publisher']);
    const t = await uploaded('Team State', org, author);
    expect(await release(t.templateId, author)).toMatchObject({
      alone: false,
      next: 'request_review',
    });
    expect((await release(t.templateId, reviewer)).next).toBeNull();

    const c = await candidateOf(org, t.templateId, t.version, author);
    expect(await release(t.templateId, author)).toMatchObject({
      review: { state: 'open', version: t.version, at: c.createdAt },
      next: 'wait',
    });
    expect((await release(t.templateId, reviewer)).next).toBe('review');
    expect((await release(t.templateId, publisher)).next).toBe('wait');

    const a = TemplateApprovalSchema.parse(
      await (await approve(org, t.templateId, c, reviewer)).json(),
    );
    expect(await release(t.templateId, publisher)).toMatchObject({
      review: { state: 'approved', at: a.createdAt },
      next: 'release',
    });
    expect((await release(t.templateId, author)).next).toBe('wait');
  });
});

describe('alone mirrors the sole approval rule', () => {
  const cases: [string, (org: OrgRow) => Promise<unknown>][] = [
    ['solo admin', async () => {}],
    ['a second reviewer', (org) => member(org.id, ['template_reviewer'])],
    ['a second member who only authors', (org) => member(org.id, ['template_author'])],
    ['a reviewer removed just now', (org) => removed(org, 0)],
    ['a reviewer removed 8 days ago', (org) => removed(org, 8 * 86_400_000)],
  ];
  async function removed(org: OrgRow, ago: number) {
    const leaving = await member(org.id, ['template_reviewer']);
    await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      clock.now() - ago,
      leaving.membershipId,
    ]);
  }

  for (const [name, setup] of cases)
    it(`agrees with a sole approval: ${name}`, async () => {
      const org = await makeOrg(f);
      const owner = await member(org.id, ['org_admin']);
      await setup(org);
      const t = await uploaded(`Alone ${name}`, org, owner);
      const { alone } = await release(t.templateId, owner);
      const c = await candidateOf(org, t.templateId, t.version, owner);
      expect((await approve(org, t.templateId, c, owner, true)).status === 201).toBe(alone);
    });
});

describe('candidate reuse', () => {
  const rows = (templateId: string) =>
    all<{ id: string }>(env.DB, 'SELECT id FROM template_candidates WHERE template_id = ?', [
      templateId,
    ]);

  it('returns the unreleased candidate for the same envelope instead of a duplicate', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Reuse', org, owner);
    const first = await candidateOf(org, t.templateId, t.version, owner);
    clock.advance(1000);
    const again = await candidateOf(org, t.templateId, t.version, owner);
    expect(again).toEqual(first);
    expect(await rows(t.templateId)).toHaveLength(1);

    const test = await candidateOf(org, t.templateId, t.version, owner, 'test');
    expect(test.id).not.toBe(first.id);

    const other = await member(org.id, ['template_author']);
    expect((await candidateOf(org, t.templateId, t.version, other)).id).not.toBe(first.id);
    expect(await rows(t.templateId)).toHaveLength(3);
  });

  it('carries the approvals and stops reusing once released', async () => {
    const org = await makeOrg(f);
    const owner = await member(org.id, ['org_admin']);
    const t = await uploaded('Reuse Released', org, owner);
    const c = await candidateOf(org, t.templateId, t.version, owner);
    const a = TemplateApprovalSchema.parse(
      await (await approve(org, t.templateId, c, owner, true)).json(),
    );
    expect((await candidateOf(org, t.templateId, t.version, owner)).approvals).toEqual([
      expect.objectContaining({ id: a.id, kind: 'sole' }),
    ]);
    await publish(org, t.templateId, c, owner, a.id);
    expect((await candidateOf(org, t.templateId, t.version, owner)).id).not.toBe(c.id);
  });
});

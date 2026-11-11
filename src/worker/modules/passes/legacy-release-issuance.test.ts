import { beforeAll, describe, expect, it } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { basicPackage, passJson, zipOf } from '../templates/package/fixtures.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { fakeAssets, importZip, sourceOf } from '../templates/testing.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { overrideDeps } from './deps.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
type Mode = 'live' | 'test';
interface Member {
  session: SessionFixture;
}
interface Imported {
  templateId: string;
  version: string;
}
interface ReleaseBody {
  id: string;
  generation: number;
  version: string;
  source: string;
  action: string;
  candidateHash: string;
}
interface ReleaseList {
  active: ReleaseBody | null;
  items: ReleaseBody[];
}

let kit: Kit;
let app: ReturnType<typeof createApp>;
let orgId: string;
let author: Member;
let reviewer: Member;
let publisher: Member;
let operator: Member;
let viewer: Member;

const unique = () => kit.fx.ids.token(12);

async function member(roles: OrgRole[]): Promise<Member> {
  const user = await makeUser(kit.fx);
  const invitationId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify(roles),
      await sha256Hex(unique()),
      now,
      now + 60_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [kit.fx.ids.id(), orgId, user.id, invitationId, JSON.stringify(roles), now],
  );
  return { session: await makeSession(kit.fx, { userId: user.id, roles: ['user'] }) };
}

function packageFor(name: string) {
  const manifest = {
    schema: 1,
    name,
    inputs: {
      type: 'object',
      required: ['memberName'],
      properties: { memberName: { type: 'string', minLength: 1 } },
    },
    sample: { memberName: 'Legacy member' },
    bindings: [{ to: { field: 'name' }, value: '{{memberName}}' }],
    display: { title: '{{memberName}}' },
  };
  return basicPackage({ 'wallet.template.json': JSON.stringify(manifest) }, passJson({}));
}

beforeAll(async () => {
  kit = await setupKit({ approvedReleases: false });
  kit.env.KEK_V1 = btoa('0123456789abcdef0123456789abcdef');
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  Object.assign(kit.env, { ASSETS: fakeAssets() });
  const registry = createTemplateRegistry(kit.env, { source: sourceOf([]), ctx: kit.ctx });
  overrideDeps(kit.env, { registry });
  app = createApp({
    stores: (env) => ({
      ...denyAllStores,
      sessions: createSessionStore(env, kit.clock),
      apiKeys: createApiKeyStore(env, kit.clock),
    }),
    clock: kit.clock,
  });
  orgId = (await makeOrg(kit.fx, { name: 'Legacy tenant' })).id;
  author = await member(['template_author']);
  reviewer = await member(['template_reviewer']);
  publisher = await member(['template_publisher']);
  operator = await member(['pass_operator']);
  viewer = await member(['org_admin']);
}, 60_000);

/** An uploaded template that was already active before reviews existed. */
async function uploadedActive(): Promise<Imported> {
  const name = `Legacy ${unique()}`;
  const result = await importZip(kit.env, kit.clock, {
    orgId,
    name,
    zip: zipOf(packageFor(name)),
    createdBy: null,
  });
  if (!result.result) throw new Error(`Template import failed at ${result.stages.join(', ')}`);
  await run(kit.env.DB, "UPDATE templates SET active_version = ?, status = 'active' WHERE id = ?", [
    result.result.version,
    result.result.templateId,
  ]);
  return result.result;
}

/** The row tools/lib/bootstrap-tenancy.ts writes for each uploaded template at cutover. */
async function bootstrapLegacy(template: Imported, mode: Mode = 'live'): Promise<string> {
  const row = await first<{ manifest: string; pass_json: string; assets: string }>(
    kit.env.DB,
    'SELECT manifest, pass_json, assets FROM template_versions WHERE template_id = ? AND version = ?',
    [template.templateId, template.version],
  );
  if (!row) throw new Error('Missing template version');
  const content = await sha256Hex(`${row.manifest}\n${row.pass_json}\n${row.assets}`);
  const candidate = await sha256Hex(
    `legacy\n${template.templateId}\n${orgId}\n${mode}\napple\n${template.version}\n${content}`,
  );
  const owner = await first<{ id: string }>(kit.env.DB, 'SELECT id FROM users LIMIT 1');
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version,
       candidate_hash, content_hash, adapter_revision, adapter_capabilities,
       audience_policy_revision, source, action, created_by, created_at)
     VALUES (?, ?, ?, ?, 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'legacy', 'legacy', ?, ?)`,
    [
      id,
      template.templateId,
      orgId,
      mode,
      template.version,
      candidate,
      content,
      owner?.id ?? null,
      kit.clock.now(),
    ],
  );
  return id;
}

const templates = (path: string, who: Member, init: RequestInit = {}) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    {
      ...init,
      headers: {
        ...who.session.headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        ...init.headers,
      },
    },
    kit.env,
  );
const send = (path: string, who: Member, body: object) =>
  templates(path, who, { method: 'POST', body: JSON.stringify(body) });
const scopeOf = () => ({ orgId, mode: 'live' as Mode, provider: 'apple' as const });

async function releases(template: Imported): Promise<ReleaseList> {
  const response = await templates(
    `/${template.templateId}/releases?${new URLSearchParams(scopeOf())}`,
    viewer,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReleaseList;
}

async function approvedRelease(template: Imported, generation: number): Promise<ReleaseBody> {
  kit.clock.advance(1);
  const path = `/${encodeURIComponent(template.templateId)}`;
  const candidate = (await (
    await send(`${path}/candidates`, author, { ...scopeOf(), version: template.version })
  ).json()) as { id: string; candidateHash: string };
  const approval = (await (
    await send(`${path}/candidates/${candidate.id}/approve`, reviewer, {
      ...scopeOf(),
      candidateHash: candidate.candidateHash,
    })
  ).json()) as { id: string };
  const response = await send(`${path}/releases`, publisher, {
    ...scopeOf(),
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: generation,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as ReleaseBody;
}

const issue = (headers: Record<string, string>, data: object) =>
  app.request(
    `${ORIGIN}/api/v1/passes`,
    {
      method: 'POST',
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': unique(),
      },
      body: JSON.stringify(data),
    },
    kit.env,
  );
const passBody = (template: Imported, release?: ReleaseBody) => ({
  orgId,
  templateId: template.templateId,
  ...(release
    ? {
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        mode: 'live',
      }
    : {}),
  input: { memberName: 'Legacy member' },
  externalId: unique(),
});

describe('legacy template releases', () => {
  it('lets a reviewed session create issue a pass from a bootstrap-shaped legacy release', async () => {
    const template = await uploadedActive();
    const id = await bootstrapLegacy(template);
    const list = await releases(template);
    expect(list.active).toMatchObject({ id, generation: 1, source: 'legacy', action: 'legacy' });
    const response = await issue(
      operator.session.headers,
      passBody(template, list.active as ReleaseBody),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const { id: passId } = (await response.json()) as { id: string };
    expect(
      await first(kit.env.DB, 'SELECT release_id, template_version FROM passes WHERE id = ?', [
        passId,
      ]),
    ).toEqual({ release_id: id, template_version: template.version });
  }, 60_000);

  it('lets an API key create resolve the legacy release without release fields', async () => {
    const template = await uploadedActive();
    const id = await bootstrapLegacy(template);
    const key = await makeApiKey(kit.fx, { orgId, scopes: ['passes:write'] });
    const response = await issue(key.headers, passBody(template));
    expect(response.status, await response.clone().text()).toBe(201);
    const { id: passId } = (await response.json()) as { id: string };
    expect(await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id = ?', [passId])).toEqual(
      { release_id: id },
    );
  }, 60_000);

  it('does not treat a legacy release in the other mode as effective', async () => {
    const template = await uploadedActive();
    await bootstrapLegacy(template, 'live');
    const key = await makeTenantTestApiKey(kit.fx, {
      orgId,
      scopes: ['passes:write'],
      mode: 'test',
    });
    const response = await issue(key.headers, passBody(template));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
  }, 60_000);

  it('is superseded by a newer approved release, which cannot be rolled back to legacy', async () => {
    const template = await uploadedActive();
    const legacyId = await bootstrapLegacy(template);
    const legacy = (await releases(template)).active as ReleaseBody;
    const next = await approvedRelease(template, 1);
    expect(next.generation).toBe(2);
    const list = await releases(template);
    expect(list.active?.id).toBe(next.id);
    expect(list.items.map((r) => [r.generation, r.source, r.action])).toEqual([
      [2, 'approved', 'release'],
      [1, 'legacy', 'legacy'],
    ]);
    // The superseded legacy binding no longer issues.
    const stale = await issue(operator.session.headers, passBody(template, legacy));
    expect(stale.status).toBe(409);
    const key = await makeApiKey(kit.fx, { orgId, scopes: ['passes:write'] });
    const viaKey = await issue(key.headers, passBody(template));
    expect(viaKey.status, await viaKey.clone().text()).toBe(201);
    const { id: passId } = (await viaKey.json()) as { id: string };
    expect(await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id = ?', [passId])).toEqual(
      { release_id: next.id },
    );
    const rollback = await send(`/${template.templateId}/releases/rollback`, publisher, {
      ...scopeOf(),
      releaseId: legacyId,
      candidateHash: legacy.candidateHash,
      expectedGeneration: 2,
      reason: 'Restore the grandfathered release',
    });
    expect(rollback.status).toBe(409);
    expect((await releases(template)).active?.id).toBe(next.id);
  }, 60_000);

  it('refuses a legacy release for a template whose active version moved', async () => {
    const template = await uploadedActive();
    await bootstrapLegacy(template);
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      'v-other',
      template.templateId,
    ]);
    const key = await makeApiKey(kit.fx, { orgId, scopes: ['passes:write'] });
    const response = await issue(key.headers, passBody(template));
    expect(response.status).toBe(409);
  }, 60_000);
});

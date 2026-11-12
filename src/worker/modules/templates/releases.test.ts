import { unzlibSync, zlibSync } from 'fflate';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanEvent,
  makeSession,
  makeUser,
  type OrgRow,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import {
  type TemplateApproval,
  TemplateApprovalSchema,
  type TemplateCandidate,
  TemplateCandidateListSchema,
  TemplateCandidateSchema,
  type TemplateRelease,
  TemplateReleaseListSchema,
  TemplateReleaseSchema,
  type TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import { SaveVersionResponseSchema } from '../../../shared/contracts/template-versions.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { setWalletProvidersEnabledForTest } from '../wallet-providers/provider-policy.ts';
import { basicPackage, makePng, passJson, zipOf } from './package/fixtures.ts';
import { canonicalJson, crc32 } from './package/hash.ts';
import { createTemplateRegistry } from './registry.ts';
import { templateContentHash } from './release-content.ts';
import { getVersion } from './repo.ts';
import { listVersionExtras } from './repo-preview-extras.ts';
import { generatedSource, resetBakedSync, syncBakedTemplates } from './sync.ts';
import { bakedFrom, beforeBatch, fakeAssets, importZip, sourceOf } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const ROLLBACK_REASON = 'Restore the previously approved release';
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
  headers: Record<string, string>;
}
let author: Actor;
let dual: Actor;
let reviewer: Actor;
let publisher: Actor;
let reader: Actor;
let admin: Actor;
let platformAdmin: Actor;
let foreign: Actor;
const bakedWorker = (id: string, timestamp: string): AppEnv => ({
  ...env,
  CF_VERSION: { id, tag: '', timestamp },
});

async function addMembership(userId: string, orgId: string, roles: OrgRole[]) {
  const invitationId = f.ids.id();
  const now = clock.now();
  const json = JSON.stringify(roles);
  await run(
    env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, json, f.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, userId, invitationId, json, now],
  );
}

async function member(orgId: string, roles: OrgRole[], platformAdmin = false): Promise<Actor> {
  const user = await makeUser(f);
  await addMembership(user.id, orgId, roles);
  const session = await makeSession(f, {
    userId: user.id,
    roles: platformAdmin ? ['admin', 'user'] : ['user'],
  });
  return { userId: user.id, headers: session.headers };
}

const scope = (mode: 'live' | 'test' = 'live', orgId = org.id): TemplateReleaseScope => ({
  orgId,
  mode,
  provider: 'apple',
});
const headersFor = (actor: Actor, mode: 'live' | 'test' = 'live') => ({
  ...actor.headers,
  ...(mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
});
const query = (s: TemplateReleaseScope) => new URLSearchParams(s).toString();
const call = (path: string, actor: Actor, init: RequestInit = {}, mode: 'live' | 'test' = 'live') =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    { ...init, headers: { ...headersFor(actor, mode), ...init.headers } },
    env,
  );
const post = (path: string, body: unknown, actor: Actor, mode: 'live' | 'test' = 'live') =>
  call(
    path,
    actor,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    mode,
  );
const assignOrg = (id: string, orgId: string | null, actor = platformAdmin) =>
  call(`/${id}`, actor, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId }),
  });
const manifest = (name: string, description?: string) => ({
  schema: 1,
  name,
  ...(description === undefined ? {} : { description }),
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
});

/** Same-sized valid PNGs with visibly different pixels, for preview-only asset tests. */
function previewImage(red: number): Uint8Array {
  const png = makePng(375, 144);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') {
      const pixels = unzlibSync(png.subarray(offset + 8, offset + 8 + length));
      for (let x = 0; x < 375; x++) {
        pixels[1 + x * 4] = red;
        pixels[4 + x * 4] = 255;
      }
      const data = zlibSync(pixels);
      const changed = new Uint8Array(png.length - length + data.length);
      changed.set(png.subarray(0, offset));
      const out = new DataView(changed.buffer);
      out.setUint32(offset, data.length);
      changed.set(png.subarray(offset + 4, offset + 8), offset + 4);
      changed.set(data, offset + 8);
      out.setUint32(offset + 8 + data.length, crc32(changed, offset + 4, offset + 8 + data.length));
      changed.set(png.subarray(offset + 12 + length), offset + 12 + data.length);
      return changed;
    }
    offset += 12 + length;
  }
  throw new Error('Fixture PNG has no IDAT chunk');
}

async function imported(
  name: string,
  actor: Actor = author,
  orgId = org.id,
  logoWidth?: number,
  metadata: {
    manifestName?: string;
    description?: string;
    passJson?: Record<string, unknown>;
  } = {},
) {
  const extra: Record<string, Uint8Array> = logoWidth ? { 'logo.png': makePng(logoWidth, 40) } : {};
  const templateManifest = manifest(metadata.manifestName ?? name, metadata.description);
  const result = await importZip(env, clock, {
    orgId,
    createdBy: actor.userId,
    name,
    zip: zipOf(
      basicPackage(
        { 'wallet.template.json': JSON.stringify(templateManifest), ...extra },
        metadata.passJson ?? passJson(),
      ),
    ),
  });
  if (!result.result) throw new Error(`Template import failed at ${result.stages.join(', ')}`);
  return { id: result.result.templateId, version: result.result.version };
}

async function candidates(id: string, s = scope(), actor = reader) {
  const response = await call(`/${id}/candidates?${query(s)}`, actor, {}, s.mode);
  expect(response.status).toBe(200);
  return TemplateCandidateListSchema.parse(await response.json()).items;
}

async function releases(id: string, s = scope(), actor = reader) {
  const response = await call(`/${id}/releases?${query(s)}`, actor, {}, s.mode);
  expect(response.status).toBe(200);
  return TemplateReleaseListSchema.parse(await response.json());
}

async function candidate(id: string, version: string, actor = author, s = scope()) {
  const response = await post(`/${id}/candidates`, { ...s, version }, actor, s.mode);
  expect(response.status).toBe(201);
  return TemplateCandidateSchema.parse(await response.json());
}

async function approval(id: string, c: TemplateCandidate, actor = reviewer, s = scope()) {
  const response = await post(
    `/${id}/candidates/${c.id}/approve`,
    { ...s, candidateHash: c.candidateHash },
    actor,
    s.mode,
  );
  expect(response.status).toBe(201);
  return TemplateApprovalSchema.parse(await response.json());
}

function publishBody(
  c: TemplateCandidate,
  a: TemplateApproval,
  expectedGeneration: number,
  s = scope(),
) {
  return {
    ...s,
    candidateId: c.id,
    approvalId: a.id,
    candidateHash: c.candidateHash,
    expectedGeneration,
  };
}

async function publish(
  id: string,
  c: TemplateCandidate,
  a: TemplateApproval,
  expectedGeneration: number,
  actor = publisher,
  s = scope(),
) {
  const response = await post(
    `/${id}/releases`,
    publishBody(c, a, expectedGeneration, s),
    actor,
    s.mode,
  );
  expect(response.status).toBe(201);
  return TemplateReleaseSchema.parse(await response.json());
}

function rollbackBody(
  r: TemplateRelease,
  expectedGeneration: number,
  s = scope(),
  reason = `  ${ROLLBACK_REASON}  `,
) {
  return { ...s, releaseId: r.id, candidateHash: r.candidateHash, expectedGeneration, reason };
}

async function rollback(
  id: string,
  r: TemplateRelease,
  expectedGeneration: number,
  s = scope(),
  reason?: string,
) {
  const response = await post(
    `/${id}/releases/rollback`,
    rollbackBody(r, expectedGeneration, s, reason),
    publisher,
    s.mode,
  );
  expect(response.status).toBe(201);
  return TemplateReleaseSchema.parse(await response.json());
}

function changedHash(hash: string) {
  return `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`;
}

function expectClientError(response: Response) {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
}

async function audits(id: string) {
  return all<{
    action: string;
    actor_type: string;
    actor_id: string;
    org_id: string;
    target_type: string;
    target_id: string;
  }>(
    env.DB,
    `SELECT action, actor_type, actor_id, org_id, target_type, target_id FROM audit_log
     WHERE target_id = ? AND action IN ('template.candidate', 'template.approve', 'template.release', 'template.rollback')
     ORDER BY id`,
    [id],
  );
}

async function setExpectedCache(id: string, value: number) {
  await run(env.DB, 'UPDATE scan_events SET expected = ?, expected_at = ? WHERE id = ?', [
    value,
    clock.now() - 1000,
    id,
  ]);
}

async function cachedEvent(
  orgId: string,
  mode: 'live' | 'test',
  templateIds: string[],
  value = 23,
) {
  const event = await makeScanEvent(f, { orgId, mode, templateIds });
  await setExpectedCache(event.id, value);
  return event.id;
}

async function expectedCache(id: string) {
  return first<{ expected: number | null; expected_at: number | null; updated_at: number }>(
    env.DB,
    'SELECT expected, expected_at, updated_at FROM scan_events WHERE id = ?',
    [id],
  );
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
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
  dual = await member(org.id, ['template_author', 'template_reviewer']);
  reviewer = await member(org.id, ['template_reviewer']);
  publisher = await member(org.id, ['template_publisher']);
  reader = await member(org.id, ['read_only']);
  admin = await member(org.id, ['org_admin']);
  await addMembership(admin.userId, otherOrg.id, ['org_admin']);
  foreign = await member(otherOrg.id, ['org_admin']);
  platformAdmin = await member(org.id, ['org_admin'], true);
  await addMembership(platformAdmin.userId, otherOrg.id, ['org_admin']);
});

describe('template release API', () => {
  it('keeps imported and edited versions as drafts, without an activation bypass', async () => {
    const t = await imported('Reviewed Draft');
    const before = await first<{ active_version: string | null; assets: string }>(
      env.DB,
      `SELECT t.active_version, v.assets FROM templates t JOIN template_versions v ON v.template_id = t.id
       WHERE t.id = ? AND v.version = ?`,
      [t.id, t.version],
    );
    expect(before?.active_version).toBeNull();
    expect(await candidates(t.id)).toEqual([]);
    expect(await releases(t.id)).toEqual({ active: null, items: [] });
    const carried = (JSON.parse(before?.assets ?? '[]') as { name: string; sha1: string }[]).map(
      ({ name, sha1 }) => ({ name, sha1 }),
    );
    const body = {
      passJson: passJson(),
      manifest: { ...manifest('Reviewed Draft'), display: { title: 'Edited {{name}}' } },
      assets: carried,
    };
    const edited = await post(`/${t.id}/versions`, body, author);
    expect(edited.status).toBe(200);
    const saved = (await edited.json()) as { version: string; saved: boolean };
    expect(saved).toMatchObject({ saved: true });
    expect(saved.version).not.toBe(t.version);
    const direct = await post(`/${t.id}/activate`, { version: saved.version }, admin);
    expect(direct.status).toBe(404);
    // A legacy `activate` field is ignored: a save is always a draft.
    for (const activate of [true, 'display-only']) {
      const bypass = await post(`/${t.id}/versions`, { ...body, activate }, admin);
      expect(bypass.status).toBe(200);
    }
    expect(
      await first(env.DB, 'SELECT active_version FROM templates WHERE id = ?', [t.id]),
    ).toEqual({
      active_version: null,
    });
    expect(await candidates(t.id)).toEqual([]);
    expect(await releases(t.id)).toEqual({ active: null, items: [] });
  });

  it('requires distinct authors and reviewers with the corresponding org capabilities', async () => {
    const ownVersion = await imported('Self Review Version', dual);
    const authored = await candidate(ownVersion.id, ownVersion.version, dual);
    expect(authored).toMatchObject({
      templateId: ownVersion.id,
      orgId: org.id,
      mode: 'live',
      provider: 'apple',
      version: ownVersion.version,
      authorId: dual.userId,
      versionAuthorId: dual.userId,
      adapterRevision: 1,
      adapterCapabilities: ['apple-passkit'],
      audiencePolicyRevision: 1,
      approvals: [],
    });
    expect(authored.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(authored.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(authored.candidateHash).toBe(
      await sha256Hex(
        canonicalJson({
          templateId: authored.templateId,
          orgId: authored.orgId,
          mode: authored.mode,
          provider: authored.provider,
          version: authored.version,
          contentHash: authored.contentHash,
          adapterRevision: authored.adapterRevision,
          adapterCapabilities: authored.adapterCapabilities,
          audiencePolicyRevision: authored.audiencePolicyRevision,
          authorId: authored.authorId,
          versionAuthorId: authored.versionAuthorId,
          createdAt: authored.createdAt,
        }),
      ),
    );
    const approvePath = `/${ownVersion.id}/candidates/${authored.id}/approve`;
    const body = { ...scope(), candidateHash: authored.candidateHash };
    const expectSelfApprovalDenied = async (response: Response) => {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'TEMPLATE_SELF_APPROVAL' });
    };
    await expectSelfApprovalDenied(await post(approvePath, body, dual));
    expect((await post(approvePath, body, author)).status).toBe(403);
    expect((await post(approvePath, body, publisher)).status).toBe(403);
    expect((await post(approvePath, body, reader)).status).toBe(403);
    expect(
      (
        await post(
          `/${ownVersion.id}/candidates`,
          { ...scope(), version: ownVersion.version },
          reviewer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          `/${ownVersion.id}/candidates`,
          { ...scope(), version: ownVersion.version },
          reader,
        )
      ).status,
    ).toBe(403);
    expect((await candidates(ownVersion.id))[0]?.approvals).toEqual([]);
    expect((await audits(ownVersion.id)).map((event) => event.action)).toEqual([
      'template.candidate',
    ]);
    const approved = await approval(ownVersion.id, authored);
    expect(approved).toMatchObject({
      candidateId: authored.id,
      candidateHash: authored.candidateHash,
      reviewerId: reviewer.userId,
    });
    expect((await candidates(ownVersion.id))[0]?.approvals).toContainEqual(approved);
    expect(
      (await post(`/${ownVersion.id}/releases`, publishBody(authored, approved, 0), reviewer))
        .status,
    ).toBe(403);
    expect(
      (await post(`/${ownVersion.id}/releases`, publishBody(authored, approved, 0), author)).status,
    ).toBe(403);
    expect(
      (await post(`/${ownVersion.id}/releases`, publishBody(authored, approved, 0), reader)).status,
    ).toBe(403);
    expect(await releases(ownVersion.id)).toEqual({ active: null, items: [] });

    // Different candidate and version authors must each be barred from approving.
    const byVersionAuthor = await candidate(ownVersion.id, ownVersion.version, author);
    expect(byVersionAuthor).toMatchObject({
      authorId: author.userId,
      versionAuthorId: dual.userId,
    });
    expect(byVersionAuthor.contentHash).toBe(authored.contentHash);
    expect(byVersionAuthor.candidateHash).not.toBe(authored.candidateHash);
    await expectSelfApprovalDenied(
      await post(
        `/${ownVersion.id}/candidates/${byVersionAuthor.id}/approve`,
        {
          ...scope(),
          candidateHash: byVersionAuthor.candidateHash,
        },
        dual,
      ),
    );
    await approval(ownVersion.id, byVersionAuthor);
    const otherVersion = await imported('Candidate Author Review', author);
    const byCandidateAuthor = await candidate(otherVersion.id, otherVersion.version, dual);
    expect(byCandidateAuthor).toMatchObject({
      authorId: dual.userId,
      versionAuthorId: author.userId,
    });
    await expectSelfApprovalDenied(
      await post(
        `/${otherVersion.id}/candidates/${byCandidateAuthor.id}/approve`,
        {
          ...scope(),
          candidateHash: byCandidateAuthor.candidateHash,
        },
        dual,
      ),
    );
    await approval(otherVersion.id, byCandidateAuthor);
  });

  it('binds versions, candidates and approvals to the exact template, org, mode and hash', async () => {
    const v1 = await imported('Bound Card');
    const v2 = await imported('Bound Card', author, org.id, 100);
    const other = await imported('Other Bound Card');
    const foreignTemplate = await imported('Foreign Bound Card', foreign, otherOrg.id);
    expect(v2.id).toBe(v1.id);
    expect(v2.version).not.toBe(v1.version);
    const a = await candidate(v1.id, v1.version);
    const b = await candidate(v1.id, v2.version);
    const c = await candidate(other.id, other.version);
    const foreignCandidate = await candidate(
      foreignTemplate.id,
      foreignTemplate.version,
      foreign,
      scope('live', otherOrg.id),
    );
    expect(a.candidateHash).not.toBe(b.candidateHash);
    expect(a.contentHash).not.toBe(b.contentHash);
    const beforeCandidates = await candidates(v1.id);
    const beforeReleases = await releases(v1.id);
    const beforeAudits = await audits(v1.id);

    expectClientError(
      await post(`/${v1.id}/candidates`, { ...scope(), version: other.version }, author),
    );
    expectClientError(
      await post(
        `/${v1.id}/candidates`,
        { ...scope('live', otherOrg.id), version: v1.version },
        admin,
      ),
    );
    expectClientError(
      await post(
        `/${v1.id}/candidates/${a.id}/approve`,
        {
          ...scope(),
          candidateHash: changedHash(a.candidateHash),
        },
        reviewer,
      ),
    );
    expectClientError(
      await post(
        `/${v1.id}/candidates/${c.id}/approve`,
        {
          ...scope(),
          candidateHash: c.candidateHash,
        },
        reviewer,
      ),
    );
    expectClientError(
      await post(
        `/${v1.id}/candidates/${foreignCandidate.id}/approve`,
        {
          ...scope(),
          candidateHash: foreignCandidate.candidateHash,
        },
        admin,
      ),
    );
    expectClientError(
      await post(
        `/${v1.id}/candidates/${a.id}/approve`,
        {
          ...scope('test'),
          candidateHash: a.candidateHash,
        },
        reviewer,
        'test',
      ),
    );
    expect(await candidates(v1.id)).toEqual(beforeCandidates);
    expect(await releases(v1.id)).toEqual(beforeReleases);
    expect(await audits(v1.id)).toEqual(beforeAudits);
    const aa = await approval(v1.id, a);
    const ab = await approval(v1.id, b);
    const ac = await approval(other.id, c);
    const foreignApproval = await approval(
      foreignTemplate.id,
      foreignCandidate,
      admin,
      scope('live', otherOrg.id),
    );
    const reviewedCandidates = await candidates(v1.id);
    const reviewedAudits = await audits(v1.id);
    for (const body of [
      { ...publishBody(a, aa, 0), candidateHash: changedHash(a.candidateHash) },
      publishBody(a, ab, 0),
      publishBody(b, aa, 0),
      publishBody(c, ac, 0),
      publishBody(foreignCandidate, foreignApproval, 0),
      { ...publishBody(a, aa, 0), ...scope('live', otherOrg.id) },
    ])
      expectClientError(await post(`/${v1.id}/releases`, body, admin));
    expect(await candidates(v1.id)).toEqual(reviewedCandidates);
    expect(await releases(v1.id)).toEqual(beforeReleases);
    expect(await audits(v1.id)).toEqual(reviewedAudits);
    expect((await call(`/${v1.id}/candidates?${query(scope())}`, foreign)).status).toBe(404);
    expect((await call(`/${v1.id}/releases?${query(scope())}`, foreign)).status).toBe(404);
    expect(
      (await call(`/${v1.id}/candidates?${query(scope('live', otherOrg.id))}`, admin)).status,
    ).toBe(404);

    const testCandidate = await candidate(v1.id, v1.version, author, scope('test'));
    const testApproval = await approval(v1.id, testCandidate, reviewer, scope('test'));
    expect(testCandidate.contentHash).toBe(a.contentHash);
    expect(testCandidate.candidateHash).not.toBe(a.candidateHash);
    expectClientError(
      await post(`/${v1.id}/releases`, publishBody(testCandidate, testApproval, 0), publisher),
    );
    expectClientError(
      await post(`/${v1.id}/releases`, publishBody(a, aa, 0, scope('test')), publisher, 'test'),
    );
    expect((await candidates(v1.id)).map((item) => item.id)).not.toContain(testCandidate.id);
    expect((await candidates(v1.id, scope('test'))).map((item) => item.id)).toEqual([
      testCandidate.id,
    ]);
    expect(await releases(v1.id)).toEqual({ active: null, items: [] });
    expect(await releases(v1.id, scope('test'))).toEqual({ active: null, items: [] });
    const liveRelease = await publish(v1.id, a, aa, 0);
    const liveTemplate = await first<{ active_version: string; updated_at: number }>(
      env.DB,
      'SELECT active_version, updated_at FROM templates WHERE id = ?',
      [v1.id],
    );
    expect(liveTemplate?.active_version).toBe(v1.version);
    const testRelease = await publish(
      v1.id,
      testCandidate,
      testApproval,
      0,
      publisher,
      scope('test'),
    );
    expect(
      await first(env.DB, 'SELECT active_version, updated_at FROM templates WHERE id = ?', [v1.id]),
    ).toEqual(liveTemplate);
    expect(liveRelease).toMatchObject({ mode: 'live', generation: 1, version: v1.version });
    expect(testRelease).toMatchObject({ mode: 'test', generation: 1, version: v1.version });
    expect((await releases(v1.id)).active).toEqual(liveRelease);
    expect((await releases(v1.id, scope('test'))).active).toEqual(testRelease);
    const liveHead = await publish(v1.id, b, ab, 1);
    const testCandidate2 = await candidate(v1.id, v2.version, author, scope('test'));
    const testApproval2 = await approval(v1.id, testCandidate2, reviewer, scope('test'));
    const testHead = await publish(
      v1.id,
      testCandidate2,
      testApproval2,
      1,
      publisher,
      scope('test'),
    );
    expectClientError(
      await post(`/${v1.id}/releases/rollback`, rollbackBody(testRelease, 2), publisher),
    );
    expectClientError(
      await post(
        `/${v1.id}/releases/rollback`,
        rollbackBody(liveRelease, 2, scope('test')),
        publisher,
        'test',
      ),
    );
    expect((await releases(v1.id)).active).toEqual(liveHead);
    expect((await releases(v1.id, scope('test'))).active).toEqual(testHead);
  });

  it('isolates releases of a shared uploaded template by organization and mode', async () => {
    const v1 = await imported('Shared Release Card');
    const v2 = await imported('Shared Release Card', author, org.id, 100);
    expect(v2.id).toBe(v1.id);
    expect((await assignOrg(v1.id, null)).status).toBe(200);
    const template = () =>
      first<{
        org_id: string | null;
        active_version: string | null;
        status: string;
        updated_at: number;
      }>(env.DB, 'SELECT org_id, active_version, status, updated_at FROM templates WHERE id = ?', [
        v1.id,
      ]);
    const baseline = await template();
    expect(baseline).toMatchObject({ org_id: null, active_version: null, status: 'active' });
    const authorB = await member(otherOrg.id, ['template_author']);
    const reviewerB = await member(otherOrg.id, ['template_reviewer']);
    const publisherB = await member(otherOrg.id, ['template_publisher']);
    const readerB = await member(otherOrg.id, ['read_only']);
    const orgB = scope('live', otherOrg.id);
    const assignmentAudits = () =>
      all(
        env.DB,
        "SELECT * FROM audit_log WHERE action = 'template.assign_org' AND target_id = ? ORDER BY id",
        [v1.id],
      );
    const assertAssignmentLocked = async () => {
      const before = await template();
      const beforeAudits = await assignmentAudits();
      const beforeCandidates = await all(
        env.DB,
        'SELECT * FROM template_candidates WHERE template_id = ? ORDER BY id',
        [v1.id],
      );
      const beforeReleases = await all(
        env.DB,
        'SELECT * FROM template_releases WHERE template_id = ? ORDER BY id',
        [v1.id],
      );
      for (const destination of [org.id, otherOrg.id]) {
        const response = await assignOrg(v1.id, destination);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
      }
      expect(await template()).toEqual(before);
      expect(await assignmentAudits()).toEqual(beforeAudits);
      expect(
        await all(env.DB, 'SELECT * FROM template_candidates WHERE template_id = ? ORDER BY id', [
          v1.id,
        ]),
      ).toEqual(beforeCandidates);
      expect(
        await all(env.DB, 'SELECT * FROM template_releases WHERE template_id = ? ORDER BY id', [
          v1.id,
        ]),
      ).toEqual(beforeReleases);
    };

    const a1 = await candidate(v1.id, v1.version);
    await assertAssignmentLocked();
    expect(await candidates(v1.id, orgB, readerB)).toEqual([]);
    expect(await releases(v1.id, orgB, readerB)).toEqual({ active: null, items: [] });
    expectClientError(await call(`/${v1.id}/candidates?${query(orgB)}`, reader));
    expectClientError(await call(`/${v1.id}/releases?${query(scope())}`, readerB));
    expectClientError(
      await post(
        `/${v1.id}/candidates/${a1.id}/approve`,
        {
          ...orgB,
          candidateHash: a1.candidateHash,
        },
        reviewerB,
      ),
    );
    const reviewA1 = await approval(v1.id, a1);
    const releaseA1 = await publish(v1.id, a1, reviewA1, 0);
    expect(releaseA1).toMatchObject({
      orgId: org.id,
      mode: 'live',
      generation: 1,
      version: v1.version,
    });
    expect(await releases(v1.id, orgB, readerB)).toEqual({ active: null, items: [] });
    expect(await releases(v1.id, scope('test'), reader)).toEqual({ active: null, items: [] });
    await assertAssignmentLocked();

    const b1 = await candidate(v1.id, v2.version, authorB, orgB);
    const reviewB1 = await approval(v1.id, b1, reviewerB, orgB);
    expectClientError(await post(`/${v1.id}/releases`, publishBody(b1, reviewB1, 1), publisher));
    const releaseB1 = await publish(v1.id, b1, reviewB1, 0, publisherB, orgB);
    expect(releaseB1).toMatchObject({
      orgId: otherOrg.id,
      mode: 'live',
      generation: 1,
      version: v2.version,
      previousReleaseId: null,
    });
    expect((await releases(v1.id)).active).toEqual(releaseA1);
    expect((await releases(v1.id, orgB, readerB)).active).toEqual(releaseB1);
    expect((await candidates(v1.id)).map((c) => c.id)).toEqual([a1.id]);
    expect((await candidates(v1.id, orgB, readerB)).map((c) => c.id)).toEqual([b1.id]);

    const a2 = await candidate(v1.id, v2.version);
    const reviewA2 = await approval(v1.id, a2);
    const releaseA2 = await publish(v1.id, a2, reviewA2, 1);
    const b2 = await candidate(v1.id, v1.version, authorB, orgB);
    const reviewB2 = await approval(v1.id, b2, reviewerB, orgB);
    const releaseB2 = await publish(v1.id, b2, reviewB2, 1, publisherB, orgB);
    expect(releaseA2).toMatchObject({
      generation: 2,
      previousReleaseId: releaseA1.id,
      version: v2.version,
    });
    expect(releaseB2).toMatchObject({
      generation: 2,
      previousReleaseId: releaseB1.id,
      version: v1.version,
    });
    expectClientError(
      await post(`/${v1.id}/releases/rollback`, rollbackBody(releaseB1, 2), publisher),
    );
    expectClientError(
      await post(`/${v1.id}/releases/rollback`, rollbackBody(releaseA1, 2, orgB), publisherB),
    );
    expect((await releases(v1.id)).active).toEqual(releaseA2);
    expect((await releases(v1.id, orgB, readerB)).active).toEqual(releaseB2);

    const testCandidate = await candidate(v1.id, v1.version, author, scope('test'));
    const testApproval = await approval(v1.id, testCandidate, reviewer, scope('test'));
    const testRelease = await publish(
      v1.id,
      testCandidate,
      testApproval,
      0,
      publisher,
      scope('test'),
    );
    expect(testRelease).toMatchObject({
      orgId: org.id,
      mode: 'test',
      generation: 1,
      version: v1.version,
    });
    expect((await releases(v1.id)).active).toEqual(releaseA2);
    expect((await releases(v1.id, orgB, readerB)).active).toEqual(releaseB2);
    expect((await releases(v1.id, scope('test'), reader)).active).toEqual(testRelease);
    expect(await releases(v1.id, scope('test', otherOrg.id), readerB)).toEqual({
      active: null,
      items: [],
    });
    expect(await template()).toEqual(baseline);

    const pending = await candidate(v1.id, v2.version, author, scope('test'));
    const pendingApproval = await approval(v1.id, pending, reviewer, scope('test'));
    expect((await post(`/${v1.id}/archive`, {}, platformAdmin)).status).toBe(200);
    const archived = await template();
    expect(archived).toMatchObject({ org_id: null, active_version: null, status: 'archived' });
    const beforeAudits = await audits(v1.id);
    const beforeReleases = await all(
      env.DB,
      'SELECT * FROM template_releases WHERE template_id = ? ORDER BY id',
      [v1.id],
    );
    const restore = await post(
      `/${v1.id}/releases`,
      publishBody(pending, pendingApproval, 1, scope('test')),
      publisher,
      'test',
    );
    expect(restore.status).toBe(409);
    expect(await template()).toEqual(archived);
    expect(await audits(v1.id)).toEqual(beforeAudits);
    expect(
      await all(env.DB, 'SELECT * FROM template_releases WHERE template_id = ? ORDER BY id', [
        v1.id,
      ]),
    ).toEqual(beforeReleases);
  }, 30_000);

  it('keeps a pre-existing shared legacy pointer unchanged when a tenant releases another version', async () => {
    const old = await imported('Shared Legacy Pointer');
    const newer = await imported('Shared Legacy Pointer', author, org.id, 100);
    expect(newer.id).toBe(old.id);
    expect((await assignOrg(old.id, null)).status).toBe(200);
    // A shared version published before reviewed releases may already have this compatibility pointer.
    await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      old.version,
      old.id,
    ]);
    const before = await first(
      env.DB,
      'SELECT org_id, active_version, status, updated_at FROM templates WHERE id = ?',
      [old.id],
    );
    const c = await candidate(old.id, newer.version);
    const a = await approval(old.id, c);
    const r = await publish(old.id, c, a, 0);
    expect(r).toMatchObject({ orgId: org.id, version: newer.version, generation: 1 });
    expect(
      await first(
        env.DB,
        'SELECT org_id, active_version, status, updated_at FROM templates WHERE id = ?',
        [old.id],
      ),
    ).toEqual(before);
    expect((await releases(old.id)).active).toEqual(r);
    expect(await releases(old.id, scope('live', otherOrg.id), foreign)).toEqual({
      active: null,
      items: [],
    });
  });

  it.each(['candidate', 'release'] as const)(
    'fences reassignment when %s history commits after the assignment preflight',
    async (kind) => {
      const draft = await imported(`Shared Assignment Race ${kind}`);
      expect((await assignOrg(draft.id, null)).status).toBe(200);
      const before = await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [draft.id]);
      const beforeAudits = await all(
        env.DB,
        "SELECT * FROM audit_log WHERE action = 'template.assign_org' AND target_id = ? ORDER BY id",
        [draft.id],
      );
      let intercepted = false;
      let createdCandidate: TemplateCandidate | undefined;
      let createdRelease: TemplateRelease | undefined;
      const raced = beforeBatch(env, /UPDATE\s+templates\s+SET\s+org_id\b/i, async () => {
        intercepted = true;
        createdCandidate = await candidate(draft.id, draft.version);
        if (kind === 'release') {
          const approved = await approval(draft.id, createdCandidate);
          createdRelease = await publish(draft.id, createdCandidate, approved, 0);
        }
      });
      const response = await app.request(
        `${ORIGIN}/api/v1/templates/${draft.id}`,
        {
          method: 'PATCH',
          headers: { ...platformAdmin.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ orgId: org.id }),
        },
        raced,
      );
      expect(intercepted).toBe(true);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
      expect(createdCandidate).toBeDefined();
      expect(await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [draft.id])).toEqual(
        before,
      );
      expect(
        await all(
          env.DB,
          "SELECT * FROM audit_log WHERE action = 'template.assign_org' AND target_id = ? ORDER BY id",
          [draft.id],
        ),
      ).toEqual(beforeAudits);
      expect((await candidates(draft.id)).map((c) => c.id)).toEqual([createdCandidate?.id]);
      const history = await releases(draft.id);
      if (kind === 'release') {
        expect(createdRelease).toBeDefined();
        expect(history.active).toEqual(createdRelease);
        expect(history.items).toEqual([createdRelease]);
      } else {
        expect(history).toEqual({ active: null, items: [] });
      }
    },
    30_000,
  );

  it('does not allow human candidates for system-owned baked templates', async () => {
    const baked = generatedSource.templates.find((template) => template.org === null);
    if (!baked) throw new Error('Expected a global baked template fixture');
    const response = await post(
      `/${baked.id}/candidates`,
      { ...scope(), version: baked.version },
      author,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'TEMPLATE_BAKED' });
    expect(
      await all(env.DB, 'SELECT id FROM template_candidates WHERE template_id = ?', [baked.id]),
    ).toEqual([]);
  });

  it('requires the request mode to match the authenticated session for every endpoint', async () => {
    const t = await imported('Mode Fenced Card');
    const c = await candidate(t.id, t.version);
    const a = await approval(t.id, c);
    const released = await publish(t.id, c, a, 0);
    const beforeCandidates = await candidates(t.id);
    const beforeReleases = await releases(t.id);
    const beforeAudits = await audits(t.id);
    for (const path of ['candidates', 'releases']) {
      expectClientError(await call(`/${t.id}/${path}?${query(scope('test'))}`, reader));
      expectClientError(await call(`/${t.id}/${path}?${query(scope())}`, reader, {}, 'test'));
    }
    const operations = [
      [`/${t.id}/candidates`, { ...scope('test'), version: t.version }, author],
      [
        `/${t.id}/candidates/${c.id}/approve`,
        { ...scope('test'), candidateHash: c.candidateHash },
        reviewer,
      ],
      [`/${t.id}/releases`, publishBody(c, a, 1, scope('test')), publisher],
      [`/${t.id}/releases/rollback`, rollbackBody(released, 1, scope('test')), publisher],
    ] as const;
    for (const [path, body, actor] of operations) {
      expectClientError(await post(path, body, actor));
      expectClientError(await post(path, { ...body, mode: 'live' }, actor, 'test'));
    }
    expect(await candidates(t.id)).toEqual(beforeCandidates);
    expect(await releases(t.id)).toEqual(beforeReleases);
    expect(await audits(t.id)).toEqual(beforeAudits);
  });

  it('restores an archived assigned template by appending a rollback to its current live head', async () => {
    const t = await imported('Restore Current Head');
    const liveCandidate = await candidate(t.id, t.version);
    const liveApproval = await approval(t.id, liveCandidate);
    const live = await publish(t.id, liveCandidate, liveApproval, 0);
    const testCandidate = await candidate(t.id, t.version, author, scope('test'));
    const testApproval = await approval(t.id, testCandidate, reviewer, scope('test'));
    const test = await publish(t.id, testCandidate, testApproval, 0, publisher, scope('test'));
    const rawRollback = (releaseId: string) =>
      run(
        env.DB,
        `INSERT INTO template_releases
        (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash,
         adapter_revision, adapter_capabilities, audience_policy_revision, source, action, candidate_id,
         approval_id, previous_release_id, rollback_of_release_id, created_by, created_at)
       SELECT ?, template_id, org_id, mode, provider, generation + 1, version, candidate_hash, content_hash,
         adapter_revision, adapter_capabilities, audience_policy_revision, 'approved', 'rollback',
         candidate_id, approval_id, id, id, ?, ?
       FROM template_releases WHERE id = ?`,
        [f.ids.id(), publisher.userId, clock.now(), releaseId],
      );
    // The SQL boundary must reject a current-head rollback while the template is still active.
    await expect(rawRollback(live.id)).rejects.toThrow();
    const beforeActiveAttempt = await first(
      env.DB,
      'SELECT status, active_version, updated_at FROM templates WHERE id = ?',
      [t.id],
    );
    const beforeActiveAudits = await audits(t.id);
    const activeAttempt = await post(
      `/${t.id}/releases/rollback`,
      rollbackBody(live, 1),
      publisher,
    );
    expect(activeAttempt.status).toBe(409);
    expect(
      await first(env.DB, 'SELECT status, active_version, updated_at FROM templates WHERE id = ?', [
        t.id,
      ]),
    ).toEqual(beforeActiveAttempt);
    expect(await audits(t.id)).toEqual(beforeActiveAudits);
    expect((await releases(t.id)).active).toEqual(live);

    expect((await post(`/${t.id}/archive`, {}, publisher)).status).toBe(200);
    const archived = await first<{ status: string; active_version: string; updated_at: number }>(
      env.DB,
      'SELECT status, active_version, updated_at FROM templates WHERE id = ?',
      [t.id],
    );
    expect(archived).toMatchObject({ status: 'archived', active_version: t.version });
    // Archiving does not authorize a Test-mode restore, even through direct SQL.
    await expect(rawRollback(test.id)).rejects.toThrow();
    const beforeTestAttempt = await audits(t.id);
    const testAttempt = await post(
      `/${t.id}/releases/rollback`,
      rollbackBody(test, 1, scope('test')),
      publisher,
      'test',
    );
    expect(testAttempt.status).toBe(409);
    expect(
      await first(env.DB, 'SELECT status, active_version, updated_at FROM templates WHERE id = ?', [
        t.id,
      ]),
    ).toEqual(archived);
    expect(await audits(t.id)).toEqual(beforeTestAttempt);
    expect(
      await all(
        env.DB,
        "SELECT id FROM template_releases WHERE template_id = ? AND mode = 'test'",
        [t.id],
      ),
    ).toEqual([{ id: test.id }]);

    const restored = await rollback(t.id, live, 1);
    expect(restored).toMatchObject({
      templateId: t.id,
      orgId: org.id,
      mode: 'live',
      version: live.version,
      generation: 2,
      previousReleaseId: live.id,
      candidateHash: live.candidateHash,
      candidateId: live.candidateId,
      approvalId: live.approvalId,
      action: 'rollback',
      source: 'approved',
      createdBy: publisher.userId,
    });
    expect(restored.id).not.toBe(live.id);
    const active = await first<{ status: string; active_version: string; updated_at: number }>(
      env.DB,
      'SELECT status, active_version, updated_at FROM templates WHERE id = ?',
      [t.id],
    );
    expect(active).toMatchObject({ status: 'active', active_version: t.version });
    expect(active?.updated_at).toBeGreaterThan(archived?.updated_at ?? 0);
    const history = await releases(t.id);
    expect(history.active).toEqual(restored);
    expect(history.items).toHaveLength(2);
    expect(history.items).toEqual(expect.arrayContaining([live, restored]));
    expect((await releases(t.id, scope('test'))).active).toEqual(test);
    const events = await all<{
      actor_type: string;
      actor_id: string;
      org_id: string;
      target_type: string;
      detail: string;
    }>(
      env.DB,
      "SELECT actor_type, actor_id, org_id, target_type, detail FROM audit_log WHERE action = 'template.rollback' AND target_id = ?",
      [t.id],
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({
      actor_type: 'user',
      actor_id: publisher.userId,
      org_id: org.id,
      target_type: 'template',
    });
    expect(JSON.parse(event?.detail ?? '{}')).toMatchObject({
      reason: ROLLBACK_REASON,
      releaseId: restored.id,
      targetReleaseId: live.id,
      generation: 2,
    });
  }, 30_000);

  it('does not restore an archived shared global template by rolling back either scoped head', async () => {
    const t = await imported('Shared Restore Current Head');
    expect((await assignOrg(t.id, null)).status).toBe(200);
    const liveCandidate = await candidate(t.id, t.version);
    const liveApproval = await approval(t.id, liveCandidate);
    const live = await publish(t.id, liveCandidate, liveApproval, 0);
    const testCandidate = await candidate(t.id, t.version, author, scope('test'));
    const testApproval = await approval(t.id, testCandidate, reviewer, scope('test'));
    const test = await publish(t.id, testCandidate, testApproval, 0, publisher, scope('test'));
    expect((await post(`/${t.id}/archive`, {}, platformAdmin)).status).toBe(200);
    const archived = await first(
      env.DB,
      'SELECT org_id, status, active_version, updated_at FROM templates WHERE id = ?',
      [t.id],
    );
    expect(archived).toMatchObject({ org_id: null, status: 'archived', active_version: null });
    const beforeRows = await all(
      env.DB,
      'SELECT * FROM template_releases WHERE template_id = ? ORDER BY id',
      [t.id],
    );
    const beforeAudits = await audits(t.id);
    expect(
      (await post(`/${t.id}/releases/rollback`, rollbackBody(live, 1), publisher)).status,
    ).toBe(409);
    expect(
      (
        await post(
          `/${t.id}/releases/rollback`,
          rollbackBody(test, 1, scope('test')),
          publisher,
          'test',
        )
      ).status,
    ).toBe(409);
    expect(
      await first(
        env.DB,
        'SELECT org_id, status, active_version, updated_at FROM templates WHERE id = ?',
        [t.id],
      ),
    ).toEqual(archived);
    expect(
      await all(env.DB, 'SELECT * FROM template_releases WHERE template_id = ? ORDER BY id', [
        t.id,
      ]),
    ).toEqual(beforeRows);
    expect(await audits(t.id)).toEqual(beforeAudits);
  }, 30_000);

  it('restores an archived template only through a new approved release or rollback generation', async () => {
    const v1 = await imported('Archived Release Card');
    const v2 = await imported('Archived Release Card', author, org.id, 105);
    const v3 = await imported('Archived Release Card', author, org.id, 115);
    const c1 = await candidate(v1.id, v1.version);
    const c2 = await candidate(v1.id, v2.version);
    const c3 = await candidate(v1.id, v3.version);
    const a1 = await approval(v1.id, c1);
    const a2 = await approval(v1.id, c2);
    const a3 = await approval(v1.id, c3);
    const testCandidate = await candidate(v1.id, v1.version, author, scope('test'));
    const testApproval = await approval(v1.id, testCandidate, reviewer, scope('test'));
    const r1 = await publish(v1.id, c1, a1, 0);
    const r2 = await publish(v1.id, c2, a2, 1);
    expect((await post(`/${v1.id}/archive`, {}, publisher)).status).toBe(200);
    const archived = await first<{ status: string; updated_at: number }>(
      env.DB,
      'SELECT status, updated_at FROM templates WHERE id = ?',
      [v1.id],
    );
    expect(archived?.status).toBe('archived');
    const testRestore = await post(
      `/${v1.id}/releases`,
      publishBody(testCandidate, testApproval, 0, scope('test')),
      publisher,
      'test',
    );
    expect(testRestore.status).toBe(409);
    expect(
      await first(env.DB, 'SELECT status, updated_at FROM templates WHERE id = ?', [v1.id]),
    ).toEqual(archived);
    expect((await post(`/${v1.id}/restore`, {}, publisher)).status).toBe(409);
    const r3 = await publish(v1.id, c3, a3, 2);
    expect(r3).toMatchObject({ generation: 3, version: v3.version, previousReleaseId: r2.id });
    const liveRestored = await first<{ status: string; updated_at: number }>(
      env.DB,
      'SELECT status, updated_at FROM templates WHERE id = ?',
      [v1.id],
    );
    expect(liveRestored?.status).toBe('active');
    expect(liveRestored?.updated_at).toBeGreaterThan(archived?.updated_at ?? 0);
    expect((await releases(v1.id)).active).toEqual(r3);
    expect((await post(`/${v1.id}/archive`, {}, publisher)).status).toBe(200);
    expect((await post(`/${v1.id}/restore`, {}, publisher)).status).toBe(409);
    const longestReason = 'x'.repeat(500);
    const r4 = await rollback(v1.id, r1, 3, scope(), `  ${longestReason}  `);
    expect(r4).toMatchObject({
      generation: 4,
      version: v1.version,
      action: 'rollback',
      previousReleaseId: r3.id,
    });
    expect(await first(env.DB, 'SELECT status FROM templates WHERE id = ?', [v1.id])).toEqual({
      status: 'active',
    });
    const history = await releases(v1.id);
    expect(history.active).toEqual(r4);
    expect(history.items).toHaveLength(4);
    expect(history.items).toEqual(expect.arrayContaining([r1, r2, r3, r4]));
    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE action = 'template.rollback' AND target_id = ? ORDER BY id DESC LIMIT 1",
      [v1.id],
    );
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({
      reason: longestReason,
      releaseId: r4.id,
    });
  });

  it.each(['approval', 'release'] as const)(
    'rejects %s when archive wins immediately before the commit',
    async (operation) => {
      const t = await imported(`Archive Race ${operation}`);
      const c = await candidate(t.id, t.version);
      const a = operation === 'release' ? await approval(t.id, c) : null;
      const beforeApprovals = await all(
        env.DB,
        'SELECT id FROM template_approvals WHERE candidate_id = ?',
        [c.id],
      );
      const beforeAudits = await audits(t.id);
      const table = operation === 'approval' ? 'template_approvals' : 'template_releases';
      const insert = new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, 'i');
      let prepared = false;
      let intercepted = false;
      const db = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              if (insert.test(sql)) prepared = true;
              return target.prepare(sql);
            };
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (prepared && !intercepted) {
                intercepted = true;
                expect((await post(`/${t.id}/archive`, {}, publisher)).status).toBe(200);
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const actor = operation === 'approval' ? reviewer : publisher;
      const path =
        operation === 'approval' ? `/${t.id}/candidates/${c.id}/approve` : `/${t.id}/releases`;
      const body = a ? publishBody(c, a, 0) : { ...scope(), candidateHash: c.candidateHash };
      const response = await app.request(
        `${ORIGIN}/api/v1/templates${path}`,
        {
          method: 'POST',
          headers: { ...actor.headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        { ...env, DB: db },
      );
      expect(intercepted).toBe(true);
      expect(response.status).toBe(409);
      expect(await first(env.DB, 'SELECT status FROM templates WHERE id = ?', [t.id])).toEqual({
        status: 'archived',
      });
      expect(
        await all(env.DB, 'SELECT id FROM template_approvals WHERE candidate_id = ?', [c.id]),
      ).toEqual(beforeApprovals);
      expect(
        await all(env.DB, 'SELECT id FROM template_releases WHERE template_id = ?', [t.id]),
      ).toEqual([]);
      expect(await audits(t.id)).toEqual(beforeAudits);
    },
  );

  it('rejects provider projection fields on Apple candidates', async () => {
    const t = await imported('Apple Candidate Without Projection');
    const before = await candidates(t.id);
    const auditBefore = await audits(t.id);
    const response = await post(
      `/${t.id}/candidates`,
      {
        ...scope(),
        version: t.version,
        sourceReleaseId: 'unrelated-source',
        projection: {},
      },
      author,
    );
    expect(response.status).toBe(422);
    expect(await candidates(t.id)).toEqual(before);
    expect(await audits(t.id)).toEqual(auditBefore);
  });

  it('keeps Apple candidates and releases separate from native provider scopes', async () => {
    const t = await imported('Provider Scope Card');
    const c = await candidate(t.id, t.version);
    const a = await approval(t.id, c);
    const r = await publish(t.id, c, a, 0);
    const beforeCandidates = await candidates(t.id);
    const beforeReleases = await releases(t.id);
    const beforeAudits = await audits(t.id);
    // Native provider scopes answer only once the providers are released.
    onTestFinished(setWalletProvidersEnabledForTest(true));
    // Provider reads revalidate the credential keyset, which only exists once initialized.
    await ensureCredentialRefKeyset(env.DB, env);
    for (const provider of ['google', 'samsung'] as const) {
      const nativeScope = { ...scope(), provider };
      expect(await candidates(t.id, nativeScope)).toEqual([]);
      expect(await releases(t.id, nativeScope)).toEqual({ items: [], active: null });
      const unreviewed = await post(
        `/${t.id}/candidates`,
        {
          ...nativeScope,
          version: t.version,
        },
        author,
      );
      expect(unreviewed.status).toBe(422);
      expectClientError(
        await post(
          `/${t.id}/candidates/${c.id}/approve`,
          {
            ...nativeScope,
            candidateHash: c.candidateHash,
          },
          reviewer,
        ),
      );
      expectClientError(
        await post(`/${t.id}/releases`, publishBody(c, a, 0, nativeScope), publisher),
      );
      expectClientError(
        await post(`/${t.id}/releases/rollback`, rollbackBody(r, 0, nativeScope), publisher),
      );
      expect(await candidates(t.id, nativeScope)).toEqual([]);
      expect(await releases(t.id, nativeScope)).toEqual({ items: [], active: null });
    }
    expect(await candidates(t.id)).toEqual(beforeCandidates);
    expect(await releases(t.id)).toEqual(beforeReleases);
    expect(await audits(t.id)).toEqual(beforeAudits);
  });

  it('publishes with generation CAS, updates version metadata, and rolls back to the prior metadata', async () => {
    const v1 = await imported('Release History Card');
    const v2 = await imported('Release History Card', author, org.id, 120, {
      manifestName: 'release history card',
      description: 'Current membership terms',
      passJson: passJson({
        generic: undefined,
        storeCard: { primaryFields: [{ key: 'name', label: 'Name', value: 'Alex Morgan' }] },
      }),
    });
    expect(v2.id).toBe(v1.id);
    const c1 = await candidate(v1.id, v1.version);
    const c2 = await candidate(v1.id, v2.version);
    const a1 = await approval(v1.id, c1);
    const a2 = await approval(v1.id, c2);
    const templateState = () =>
      first<{
        active_version: string | null;
        name: string;
        description: string | null;
        styles: string;
        updated_at: number;
      }>(
        env.DB,
        'SELECT active_version, name, description, styles, updated_at FROM templates WHERE id = ?',
        [v1.id],
      );
    const initialTemplate = await templateState();
    if (!initialTemplate) throw new Error('Expected template before release');
    expect(initialTemplate).toMatchObject({
      active_version: null,
      name: 'Release History Card',
      description: null,
    });
    expect(JSON.parse(initialTemplate.styles)).toEqual(['generic']);
    const firstRelease = await publish(v1.id, c1, a1, 0);
    expect(firstRelease).toMatchObject({
      templateId: v1.id,
      orgId: org.id,
      mode: 'live',
      provider: 'apple',
      version: v1.version,
      generation: 1,
      candidateId: c1.id,
      approvalId: a1.id,
      candidateHash: c1.candidateHash,
      source: 'approved',
      action: 'release',
      previousReleaseId: null,
      createdBy: publisher.userId,
    });
    const afterFirstRelease = await templateState();
    if (!afterFirstRelease) throw new Error('Expected template after first release');
    expect(afterFirstRelease).toMatchObject({
      active_version: v1.version,
      name: 'Release History Card',
      description: null,
    });
    expect(JSON.parse(afterFirstRelease.styles)).toEqual(['generic']);
    expect(afterFirstRelease.updated_at).toBeGreaterThan(initialTemplate.updated_at);
    const stalePublish = await post(`/${v1.id}/releases`, publishBody(c2, a2, 0), publisher);
    expect(stalePublish.status).toBe(409);
    expect((await releases(v1.id)).active).toEqual(firstRelease);
    const second = await publish(v1.id, c2, a2, 1);
    expect(second).toMatchObject({
      version: v2.version,
      generation: 2,
      previousReleaseId: firstRelease.id,
      candidateHash: c2.candidateHash,
      candidateId: c2.id,
      approvalId: a2.id,
    });
    const afterSecondRelease = await templateState();
    if (!afterSecondRelease) throw new Error('Expected template after second release');
    expect(afterSecondRelease).toMatchObject({
      active_version: v2.version,
      // The import's name overrides the manifest's (analyze.ts), so only the description follows.
      name: 'Release History Card',
      description: 'Current membership terms',
    });
    expect(JSON.parse(afterSecondRelease.styles)).toEqual(['storeCard']);
    expect(afterSecondRelease.updated_at).toBeGreaterThan(afterFirstRelease.updated_at);
    const validRollback = rollbackBody(firstRelease, 2);
    const { reason: _reason, ...missingReason } = validRollback;
    const beforeInvalid = await releases(v1.id);
    const beforeInvalidAudits = await audits(v1.id);
    for (const body of [
      missingReason,
      { ...validRollback, reason: '' },
      { ...validRollback, reason: '  \n\t  ' },
      { ...validRollback, reason: 'x'.repeat(501) },
    ]) {
      expect((await post(`/${v1.id}/releases/rollback`, body, publisher)).status).toBe(422);
    }
    expect(await releases(v1.id)).toEqual(beforeInvalid);
    expect(await audits(v1.id)).toEqual(beforeInvalidAudits);
    for (const actor of [author, reviewer, reader]) {
      expect(
        (await post(`/${v1.id}/releases/rollback`, rollbackBody(firstRelease, 2), actor)).status,
      ).toBe(403);
    }
    const staleRollback = await post(
      `/${v1.id}/releases/rollback`,
      rollbackBody(firstRelease, 1),
      publisher,
    );
    expect(staleRollback.status).toBe(409);
    const wrongHash = await post(
      `/${v1.id}/releases/rollback`,
      {
        ...rollbackBody(firstRelease, 2),
        candidateHash: changedHash(firstRelease.candidateHash),
      },
      publisher,
    );
    expectClientError(wrongHash);
    const reused = await post(`/${v1.id}/releases`, publishBody(c1, a1, 2), publisher);
    expectClientError(reused);
    expect((await releases(v1.id)).active).toEqual(second);
    const restored = await rollback(v1.id, firstRelease, 2);
    expect(restored).toMatchObject({
      version: v1.version,
      generation: 3,
      previousReleaseId: second.id,
      candidateHash: firstRelease.candidateHash,
      source: 'approved',
      action: 'rollback',
      createdBy: publisher.userId,
    });
    expect(restored.id).not.toBe(firstRelease.id);
    const afterRollback = await templateState();
    if (!afterRollback) throw new Error('Expected template after rollback');
    expect(afterRollback).toMatchObject({
      active_version: v1.version,
      name: 'Release History Card',
      description: null,
    });
    expect(JSON.parse(afterRollback.styles)).toEqual(['generic']);
    expect(afterRollback.updated_at).toBeGreaterThan(afterSecondRelease.updated_at);
    const history = await releases(v1.id);
    expect(history.active).toEqual(restored);
    expect(history.items).toHaveLength(3);
    expect(history.items).toEqual(expect.arrayContaining([firstRelease, second, restored]));
    const rollbackAudit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE action = 'template.rollback' AND target_id = ? ORDER BY id DESC LIMIT 1",
      [v1.id],
    );
    expect(JSON.parse(rollbackAudit?.detail ?? '{}')).toMatchObject({
      reason: ROLLBACK_REASON,
      releaseId: restored.id,
      targetReleaseId: firstRelease.id,
      generation: 3,
    });
    const events = await audits(v1.id);
    expect(
      events.map(({ action, actor_type, actor_id, org_id, target_type, target_id }) => ({
        action,
        actor_type,
        actor_id,
        org_id,
        target_type,
        target_id,
      })),
    ).toEqual([
      ...[c1, c2].map(() => ({
        action: 'template.candidate',
        actor_type: 'user',
        actor_id: author.userId,
        org_id: org.id,
        target_type: 'template',
        target_id: v1.id,
      })),
      ...[a1, a2].map(() => ({
        action: 'template.approve',
        actor_type: 'user',
        actor_id: reviewer.userId,
        org_id: org.id,
        target_type: 'template',
        target_id: v1.id,
      })),
      ...['template.release', 'template.release', 'template.rollback'].map((action) => ({
        action,
        actor_type: 'user',
        actor_id: publisher.userId,
        org_id: org.id,
        target_type: 'template',
        target_id: v1.id,
      })),
    ]);
  });

  it('invalidates only matching org, mode and template event caches on publish and rollback', async () => {
    const v1 = await imported('Shared Event Release');
    const v2 = await imported('Shared Event Release', author, org.id, 100);
    expect((await assignOrg(v1.id, null)).status).toBe(200);
    const unrelated = await imported('Unrelated Event Release');
    const c1 = await candidate(v1.id, v1.version);
    const c2 = await candidate(v1.id, v2.version);
    const a1 = await approval(v1.id, c1);
    const a2 = await approval(v1.id, c2);
    const live1 = await cachedEvent(org.id, 'live', [v1.id], 11);
    const live2 = await cachedEvent(org.id, 'live', [v1.id, unrelated.id], 12);
    const test = await cachedEvent(org.id, 'test', [v1.id], 13);
    const foreign = await cachedEvent(otherOrg.id, 'live', [v1.id], 14);
    const otherTemplate = await cachedEvent(org.id, 'live', [unrelated.id], 15);
    const noTemplate = await cachedEvent(org.id, 'live', [], 16);
    const allEvents = [live1, live2, test, foreign, otherTemplate, noTemplate];
    const before = await Promise.all(allEvents.map(expectedCache));
    const r1 = await publish(v1.id, c1, a1, 0);
    for (const [index, event] of allEvents.entries()) {
      const original = before[index];
      expect(await expectedCache(event)).toEqual(
        index < 2
          ? { expected: null, expected_at: null, updated_at: original?.updated_at }
          : original,
      );
    }
    await setExpectedCache(live1, 31);
    await setExpectedCache(live2, 32);
    const staleBefore = await Promise.all(allEvents.map(expectedCache));
    const staleAudits = await audits(v1.id);
    expect((await post(`/${v1.id}/releases`, publishBody(c2, a2, 0), publisher)).status).toBe(409);
    expect((await post(`/${v1.id}/releases/rollback`, rollbackBody(r1, 1), publisher)).status).toBe(
      409,
    );
    expect(await Promise.all(allEvents.map(expectedCache))).toEqual(staleBefore);
    expect(await audits(v1.id)).toEqual(staleAudits);
    const r2 = await publish(v1.id, c2, a2, 1);
    for (const [index, event] of allEvents.entries()) {
      const original = before[index];
      expect(await expectedCache(event)).toEqual(
        index < 2
          ? { expected: null, expected_at: null, updated_at: original?.updated_at }
          : original,
      );
    }
    await setExpectedCache(live1, 41);
    await setExpectedCache(live2, 42);
    const restored = await rollback(v1.id, r1, 2);
    expect(restored.previousReleaseId).toBe(r2.id);
    for (const [index, event] of allEvents.entries()) {
      const original = before[index];
      expect(await expectedCache(event)).toEqual(
        index < 2
          ? { expected: null, expected_at: null, updated_at: original?.updated_at }
          : original,
      );
    }
    await setExpectedCache(live1, 51);
    await setExpectedCache(live2, 52);
    const liveCache1 = await expectedCache(live1);
    const liveCache2 = await expectedCache(live2);
    const testCandidate = await candidate(v1.id, v1.version, author, scope('test'));
    const testApproval = await approval(v1.id, testCandidate, reviewer, scope('test'));
    await publish(v1.id, testCandidate, testApproval, 0, publisher, scope('test'));
    expect(await expectedCache(test)).toEqual({
      expected: null,
      expected_at: null,
      updated_at: before[2]?.updated_at,
    });
    expect(await expectedCache(live1)).toEqual(liveCache1);
    expect(await expectedCache(live2)).toEqual(liveCache2);
    expect(await expectedCache(foreign)).toEqual(before[3]);
    expect(await expectedCache(otherTemplate)).toEqual(before[4]);
    expect(await expectedCache(noTemplate)).toEqual(before[5]);
  }, 30_000);

  it.each(['publish', 'rollback'] as const)(
    'does not commit %s if event cache invalidation fails',
    async (operation) => {
      const v1 = await imported(`Event Invalidation Atomic ${operation}`);
      const v2 = await imported(`Event Invalidation Atomic ${operation}`, author, org.id, 105);
      const c1 = await candidate(v1.id, v1.version);
      const c2 = await candidate(v1.id, v2.version);
      const a1 = await approval(v1.id, c1);
      const a2 = await approval(v1.id, c2);
      let prior: TemplateRelease | null = null;
      if (operation === 'rollback') {
        prior = await publish(v1.id, c1, a1, 0);
        await publish(v1.id, c2, a2, 1);
      }
      const event = await cachedEvent(org.id, 'live', [v1.id]);
      const cacheBefore = await expectedCache(event);
      const historyBefore = await releases(v1.id);
      const auditsBefore = await audits(v1.id);
      const templateBefore = await first(
        env.DB,
        'SELECT status, active_version, updated_at FROM templates WHERE id = ?',
        [v1.id],
      );
      await run(
        env.DB,
        `CREATE TRIGGER fail_release_event_cache BEFORE UPDATE OF expected, expected_at ON scan_events
        WHEN OLD.id = '${event}' BEGIN SELECT RAISE(ABORT, 'cache down'); END`,
      );
      try {
        const path =
          operation === 'rollback' ? `/${v1.id}/releases/rollback` : `/${v1.id}/releases`;
        const body = prior ? rollbackBody(prior, 2) : publishBody(c1, a1, 0);
        expect((await post(path, body, publisher)).status).toBe(500);
      } finally {
        await run(env.DB, 'DROP TRIGGER fail_release_event_cache');
      }
      expect(await expectedCache(event)).toEqual(cacheBefore);
      expect(await releases(v1.id)).toEqual(historyBefore);
      expect(await audits(v1.id)).toEqual(auditsBefore);
      expect(
        await first(
          env.DB,
          'SELECT status, active_version, updated_at FROM templates WHERE id = ?',
          [v1.id],
        ),
      ).toEqual(templateBefore);
      if (prior) await rollback(v1.id, prior, 2);
      else await publish(v1.id, c1, a1, 0);
      expect(await expectedCache(event)).toEqual({
        expected: null,
        expected_at: null,
        updated_at: cacheBefore?.updated_at,
      });
    },
    30_000,
  );

  it('does not clear a recounted event when another release wins before the losing CAS batch', async () => {
    const v1 = await imported('Event CAS Race');
    const v2 = await imported('Event CAS Race', author, org.id, 110);
    const winnerCandidate = await candidate(v1.id, v1.version);
    const loserCandidate = await candidate(v1.id, v2.version);
    const winnerApproval = await approval(v1.id, winnerCandidate);
    const loserApproval = await approval(v1.id, loserCandidate);
    const event = await cachedEvent(org.id, 'live', [v1.id]);
    const initial = await expectedCache(event);
    const sqlOf = new WeakMap<D1PreparedStatement, string>();
    let intervened = false;
    let winner: TemplateRelease | undefined;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values);
                    sqlOf.set(bound, sql);
                    return bound;
                  };
                const value = Reflect.get(prepared, member, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (
              !intervened &&
              statements.some((statement) =>
                /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+template_releases\b/i.test(
                  sqlOf.get(statement) ?? '',
                ),
              )
            ) {
              intervened = true;
              winner = await publish(v1.id, winnerCandidate, winnerApproval, 0);
              await setExpectedCache(event, 91);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const loser = await app.request(
      `${ORIGIN}/api/v1/templates/${v1.id}/releases`,
      {
        method: 'POST',
        headers: { ...publisher.headers, 'content-type': 'application/json' },
        body: JSON.stringify(publishBody(loserCandidate, loserApproval, 0)),
      },
      { ...env, DB: db },
    );
    expect(intervened).toBe(true);
    expect(loser.status).toBe(409);
    expect(await expectedCache(event)).toEqual({
      expected: 91,
      expected_at: clock.now() - 1000,
      updated_at: initial?.updated_at,
    });
    const history = await releases(v1.id);
    expect(history.active).toEqual(winner);
    expect(history.items).toHaveLength(1);
    expect(
      (await audits(v1.id)).filter((event) => event.action === 'template.release'),
    ).toHaveLength(1);
  }, 30_000);

  it('lets only one concurrent publisher claim an expected generation', async () => {
    const v1 = await imported('Concurrent Releases Card');
    const v2 = await imported('Concurrent Releases Card', author, org.id, 110);
    const c1 = await candidate(v1.id, v1.version);
    const c2 = await candidate(v1.id, v2.version);
    const a1 = await approval(v1.id, c1);
    const a2 = await approval(v1.id, c2);
    const responses = await Promise.all([
      post(`/${v1.id}/releases`, publishBody(c1, a1, 0), publisher),
      post(`/${v1.id}/releases`, publishBody(c2, a2, 0), publisher),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const history = await releases(v1.id);
    expect(history.items).toHaveLength(1);
    expect(history.active).toEqual(history.items[0]);
    expect(history.active?.generation).toBe(1);
    expect([c1.id, c2.id]).toContain(history.active?.candidateId);
    expect(
      (await audits(v1.id)).filter((event) => event.action === 'template.release'),
    ).toHaveLength(1);
  });

  it('binds uploaded and edited preview-only pixels to immutable candidate approvals', async () => {
    const name = 'Preview Only Approval';
    const inputManifest = { ...manifest(name), previewOnlyAssets: ['strip.png', 'background.png'] };
    const original = previewImage(40);
    const changed = previewImage(200);
    const background = makePng(343, 503);
    const importedPreview = await importZip(env, clock, {
      orgId: org.id,
      createdBy: author.userId,
      name,
      zip: zipOf(
        basicPackage({
          'wallet.template.json': JSON.stringify(inputManifest),
          'strip.png': original,
          'background.png': background,
        }),
      ),
    });
    if (!importedPreview.result) throw new Error('Preview-only package import failed');
    const { templateId: id, version: oldVersion } = importedPreview.result;
    const entries = z.array(
      z.object({
        name: z.string(),
        sha1: z.string(),
        source: z.object({ kind: z.literal('r2'), key: z.string() }),
      }),
    );
    const storedVersion = async (version: string) => {
      const row = await first<{ manifest: string; pass_json: string; assets: string }>(
        env.DB,
        'SELECT manifest, pass_json, assets FROM template_versions WHERE template_id = ? AND version = ?',
        [id, version],
      );
      if (!row) throw new Error('Imported preview version is missing');
      return { ...row, entries: entries.parse(JSON.parse(row.assets)) };
    };
    const old = await storedVersion(oldVersion);
    const oldPreview = old.entries.find((entry) => entry.name === 'strip.png');
    if (!oldPreview) throw new Error('The imported preview-only asset was discarded');
    const oldBackground = old.entries.find((entry) => entry.name === 'background.png');
    if (!oldBackground) throw new Error('The second preview-only asset was discarded');
    const backgroundObject = await env.BUCKET.get(oldBackground.source.key);
    if (!backgroundObject) throw new Error('The second preview-only asset is missing');
    expect(new Uint8Array(await backgroundObject.arrayBuffer())).toEqual(background);
    const oldObject = await env.BUCKET.get(oldPreview.source.key);
    if (!oldObject) throw new Error('The imported preview-only asset is missing');
    expect(new Uint8Array(await oldObject.arrayBuffer())).toEqual(original);
    const oldCandidate = await candidate(id, oldVersion);
    const oldApproval = await approval(id, oldCandidate);
    const edit = await post(
      `/${id}/versions`,
      {
        passJson: passJson(),
        manifest: inputManifest,
        assets: [
          ...old.entries
            .filter((entry) => entry.name !== 'strip.png')
            .map(({ name: assetName, sha1 }) => ({ name: assetName, sha1 })),
          { name: 'strip.png', upload: btoa(String.fromCharCode(...changed)) },
        ],
      },
      author,
    );
    expect(edit.status).toBe(200);
    const saved = SaveVersionResponseSchema.parse(await edit.json());
    expect(saved).toMatchObject({ saved: true, created: true });
    if (!saved.version) throw new Error('Edited preview version has no version');
    expect(saved.version).not.toBe(oldVersion);
    const next = await storedVersion(saved.version);
    const nextPreview = next.entries.find((entry) => entry.name === 'strip.png');
    if (!nextPreview) throw new Error('The edited preview-only asset was discarded');
    expect(next.entries.find((entry) => entry.name === 'background.png')?.sha1).toBe(
      oldBackground.sha1,
    );
    expect(JSON.parse(next.manifest)).toEqual(JSON.parse(old.manifest));
    expect(JSON.parse(next.pass_json)).toEqual(JSON.parse(old.pass_json));
    expect(nextPreview.sha1).not.toBe(oldPreview.sha1);
    const nextObject = await env.BUCKET.get(nextPreview.source.key);
    if (!nextObject) throw new Error('The edited preview-only asset is missing');
    expect(new Uint8Array(await nextObject.arrayBuffer())).toEqual(changed);
    const nextCandidate = await candidate(id, saved.version);
    expect(nextCandidate.contentHash).not.toBe(oldCandidate.contentHash);
    expect(nextCandidate.candidateHash).not.toBe(oldCandidate.candidateHash);
    expectClientError(
      await post(
        `/${id}/candidates/${nextCandidate.id}/approve`,
        {
          ...scope(),
          candidateHash: oldCandidate.candidateHash,
        },
        reviewer,
      ),
    );
    expectClientError(
      await post(`/${id}/releases`, publishBody(nextCandidate, oldApproval, 0), publisher),
    );
    for (const [asset, bytes] of [
      [oldPreview, original],
      [oldBackground, background],
    ] as const) {
      await env.BUCKET.put(asset.source.key, changed);
      try {
        const stale = await post(
          `/${id}/releases`,
          publishBody(oldCandidate, oldApproval, 0),
          publisher,
        );
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ code: 'TEMPLATE_CONTENT_CHANGED' });
        expect(await releases(id)).toEqual({ active: null, items: [] });
      } finally {
        await env.BUCKET.put(asset.source.key, bytes);
      }
    }
    const nextApproval = await approval(id, nextCandidate);
    expect((await publish(id, nextCandidate, nextApproval, 0)).version).toBe(saved.version);
    const reuploadedBytes = previewImage(110);
    const reuploaded = await importZip(env, clock, {
      orgId: org.id,
      createdBy: author.userId,
      name,
      zip: zipOf(
        basicPackage({
          'wallet.template.json': JSON.stringify(inputManifest),
          'strip.png': reuploadedBytes,
          'background.png': background,
        }),
      ),
    });
    if (!reuploaded.result) throw new Error('Changed preview-only package import failed');
    expect(reuploaded.result.templateId).toBe(id);
    expect([oldVersion, saved.version]).not.toContain(reuploaded.result.version);
    const uploadCandidate = await candidate(id, reuploaded.result.version);
    expect(uploadCandidate.contentHash).not.toBe(nextCandidate.contentHash);
    expect(uploadCandidate.candidateHash).not.toBe(nextCandidate.candidateHash);
    expectClientError(
      await post(`/${id}/releases`, publishBody(uploadCandidate, nextApproval, 1), publisher),
    );
    expect((await releases(id)).active?.version).toBe(saved.version);
    for (const [version, expected] of [
      [oldVersion, original],
      [saved.version, changed],
      [reuploaded.result.version, reuploadedBytes],
    ] as const) {
      const asset = await call(
        `/${id}/versions/${version}/assets/strip.png?orgId=${org.id}`,
        reader,
      );
      expect(asset.status).toBe(200);
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(expected);
    }
  }, 30_000);

  it('refuses a legacy version that declares a preview asset it did not preserve', async () => {
    const t = await imported('Legacy Missing Preview');
    const legacy = 'legacy-missing-preview';
    await run(
      env.DB,
      `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
      SELECT template_id, ?, build_key, json_set(manifest, '$.previewOnlyAssets', json_array('strip.png')),
        pass_json, assets, report, created_by, created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
      [legacy, t.id, t.version],
    );
    const before = await audits(t.id);
    const response = await post(`/${t.id}/candidates`, { ...scope(), version: legacy }, author);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TEMPLATE_CONTENT_CHANGED' });
    expect(await candidates(t.id)).toEqual([]);
    expect(await releases(t.id)).toEqual({ active: null, items: [] });
    expect(await audits(t.id)).toEqual(before);
  });

  it('fails closed if stored asset bytes no longer match the approved snapshot', async () => {
    const t = await imported('Asset Binding Card');
    const c = await candidate(t.id, t.version);
    const a = await approval(t.id, c);
    const row = await first<{ assets: string }>(
      env.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? AND version = ?',
      [t.id, t.version],
    );
    const entries = JSON.parse(row?.assets ?? '[]') as { source: { kind: string; key?: string } }[];
    const key = entries.find((entry) => entry.source.kind === 'r2')?.source.key;
    if (!key) throw new Error('Imported fixture has no R2 asset');
    const object = await env.BUCKET.get(key);
    if (!object) throw new Error('Imported fixture asset is missing');
    const bytes = await object.arrayBuffer();
    await env.BUCKET.put(key, new Uint8Array([1, 2, 3]));
    try {
      const response = await post(`/${t.id}/releases`, publishBody(c, a, 0), publisher);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await releases(t.id)).toEqual({ active: null, items: [] });
      expect((await audits(t.id)).filter((event) => event.action === 'template.release')).toEqual(
        [],
      );
    } finally {
      await env.BUCKET.put(key, bytes);
    }
    expect((await publish(t.id, c, a, 0)).candidateHash).toBe(c.candidateHash);
  });

  it('does not commit a release if its audit event cannot be written', async () => {
    const t = await imported('Atomic Audit Card');
    const c = await candidate(t.id, t.version);
    const a = await approval(t.id, c);
    await run(
      env.DB,
      `CREATE TRIGGER fail_template_release_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'template.release' BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
    );
    try {
      const response = await post(`/${t.id}/releases`, publishBody(c, a, 0), publisher);
      expect(response.status).toBe(500);
    } finally {
      await run(env.DB, 'DROP TRIGGER fail_template_release_audit');
    }
    expect(await releases(t.id)).toEqual({ active: null, items: [] });
    expect((await audits(t.id)).filter((event) => event.action === 'template.release')).toEqual([]);
    expect((await publish(t.id, c, a, 0)).generation).toBe(1);
  });
});

describe('trusted baked template releases', () => {
  let priorSettings: { key: string; value: string; updated_at: number }[];
  const testSettings = `scope = 'system' AND
    (key IN ('templates.baked_adoption', 'templates.baked_hash') OR key LIKE 'templates.baked_seen:release-%')`;

  beforeEach(async () => {
    priorSettings = await all(
      env.DB,
      `SELECT key, value, updated_at FROM settings WHERE ${testSettings}`,
    );
  });

  afterEach(async () => {
    await run(env.DB, `DELETE FROM settings WHERE ${testSettings}`);
    for (const row of priorSettings) {
      await run(
        env.DB,
        "INSERT INTO settings (scope, key, value, updated_at) VALUES ('system', ?, ?, ?)",
        [row.key, row.value, row.updated_at],
      );
    }
    resetBakedSync();
  });

  it('records scoped system generations for both modes and is idempotent on unchanged content', async () => {
    const owned = await bakedFrom('release-owned', basicPackage(), {
      name: 'Owned Baked Release',
      org: { slug: org.slug, name: org.name },
    });
    const global = await bakedFrom('release-global', basicPackage(), {
      name: 'Global Baked Release',
    });
    for (const fixture of [owned, global])
      for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    const ctx = createServiceContext(bakedWorker('baked-first', '9991-01-01T00:00:00Z'), { clock });
    await syncBakedTemplates(ctx, sourceOf([owned, global], 'release-system-first'));
    type Row = {
      id: string;
      template_id: string;
      org_id: string | null;
      mode: string;
      provider: string;
      version: string;
      generation: number;
      candidate_hash: string;
      content_hash: string;
      source: string;
      action: string;
      previous_release_id: string | null;
      candidate_id: string | null;
      approval_id: string | null;
      created_by: string | null;
    };
    const rows = () =>
      all<Row>(
        env.DB,
        `SELECT id, template_id, org_id, mode, provider, version, generation, candidate_hash, content_hash,
       source, action, previous_release_id, candidate_id, approval_id, created_by
       FROM template_releases WHERE template_id IN (?, ?) ORDER BY template_id, mode, generation`,
        [owned.template.id, global.template.id],
      );
    const systemAudits = () =>
      all<{
        org_id: string | null;
        actor_type: string;
        actor_id: string | null;
        target_type: string;
        target_id: string;
        detail: string;
      }>(
        env.DB,
        `SELECT org_id, actor_type, actor_id, target_type, target_id, detail FROM audit_log
       WHERE action = 'template.release' AND target_id IN (?, ?) ORDER BY id`,
        [owned.template.id, global.template.id],
      );
    const auditDetail = z.object({
      source: z.literal('system'),
      provider: z.literal('apple'),
      mode: z.enum(['live', 'test']),
    });
    const initial = await rows();
    expect(initial).toHaveLength(4);
    for (const fixture of [owned, global]) {
      const versions = initial.filter((row) => row.template_id === fixture.template.id);
      expect(versions.map((row) => row.mode).sort()).toEqual(['live', 'test']);
      for (const row of versions) {
        expect(row).toMatchObject({
          org_id: fixture === owned ? org.id : null,
          provider: 'apple',
          version: fixture.template.version,
          generation: 1,
          source: 'system',
          action: 'system',
          previous_release_id: null,
          candidate_id: null,
          approval_id: null,
          created_by: null,
        });
        expect(row.candidate_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    const initialAudits = await systemAudits();
    expect(initialAudits).toHaveLength(4);
    for (const row of initialAudits) {
      expect(row).toMatchObject({
        org_id: row.target_id === owned.template.id ? org.id : null,
        actor_type: 'system',
        actor_id: null,
        target_type: 'template',
      });
      auditDetail.parse(JSON.parse(row.detail));
    }
    for (const fixture of [owned, global]) {
      expect(
        initialAudits
          .filter((row) => row.target_id === fixture.template.id)
          .map((row) => auditDetail.parse(JSON.parse(row.detail)).mode)
          .sort(),
      ).toEqual(['live', 'test']);
    }
    await syncBakedTemplates(ctx, sourceOf([owned, global], 'release-system-first'));
    await syncBakedTemplates(
      createServiceContext(bakedWorker('baked-unchanged', '9992-01-01T00:00:00Z'), { clock }),
      sourceOf([owned, global], 'release-system-unchanged'),
    );
    expect(await rows()).toEqual(initial);
    expect(await systemAudits()).toEqual(initialAudits);

    const next = await bakedFrom('release-owned', basicPackage({ 'logo.png': makePng(90, 40) }), {
      name: 'Owned Baked Release',
      org: { slug: org.slug, name: org.name },
    });
    for (const [path, bytes] of next.files) assets.files.set(path, bytes);
    await syncBakedTemplates(
      createServiceContext(bakedWorker('baked-next', '9993-01-01T00:00:00Z'), { clock }),
      sourceOf([next, global], 'release-system-next'),
    );
    const after = await rows();
    expect(after).toHaveLength(6);
    expect(await systemAudits()).toHaveLength(6);
    for (const mode of ['live', 'test']) {
      const old = initial.find((row) => row.template_id === owned.template.id && row.mode === mode);
      const newer = after.find(
        (row) => row.template_id === owned.template.id && row.mode === mode && row.generation === 2,
      );
      expect(newer).toMatchObject({
        org_id: org.id,
        version: next.template.version,
        source: 'system',
        action: 'system',
        previous_release_id: old?.id,
        candidate_id: null,
        approval_id: null,
        created_by: null,
      });
      expect(newer?.id).not.toBe(old?.id);
      expect(newer?.candidate_hash).not.toBe(old?.candidate_hash);
    }
    expect(after.filter((row) => row.template_id === global.template.id)).toEqual(
      initial.filter((row) => row.template_id === global.template.id),
    );
  });

  it('pins and hashes historical baked preview extras across redeploys and tampering', async () => {
    const oldBytes = previewImage(35);
    const newBytes = previewImage(220);
    const background = makePng(343, 503);
    const old = await bakedFrom(
      'release-preview-extra',
      basicPackage({ 'strip.png': oldBytes, 'background.png': background }),
      {
        name: 'Baked Preview Extra',
        org: { slug: org.slug, name: org.name },
      },
    );
    const next = await bakedFrom(
      'release-preview-extra',
      basicPackage({ 'strip.png': newBytes, 'background.png': background }),
      {
        name: 'Baked Preview Extra',
        org: { slug: org.slug, name: org.name },
      },
    );
    const oldExtra = old.template.extras.find((entry) => entry.name === 'strip.png');
    const newExtra = next.template.extras.find((entry) => entry.name === 'strip.png');
    if (!oldExtra || !newExtra)
      throw new Error('Baked preview fixtures must contain unused extras');
    expect(old.template.extras.map((entry) => entry.name).sort()).toEqual([
      'background.png',
      'strip.png',
    ]);
    expect(old.template.version).not.toBe(next.template.version);
    for (const fixture of [old, next])
      for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    const firstCtx = createServiceContext(
      bakedWorker('baked-preview-first', '9991-01-01T00:00:00Z'),
      { clock },
    );
    const firstSource = sourceOf([old], 'release-preview-extra-first');
    await syncBakedTemplates(firstCtx, firstSource);
    const savedExtra = await first<{
      name: string;
      size: number;
      sha1: string;
      sha256: string;
      r2_key: string;
    }>(
      env.DB,
      'SELECT name, size, sha1, sha256, r2_key FROM template_version_extras WHERE template_id = ? AND version = ? AND name = ?',
      [old.template.id, old.template.version, 'strip.png'],
    );
    if (!savedExtra) throw new Error('Baked preview extra was not persisted');
    expect(savedExtra).toMatchObject({
      name: 'strip.png',
      size: oldBytes.length,
      sha1: oldExtra.sha1,
      sha256: await sha256Hex(oldBytes),
    });
    expect(savedExtra.r2_key).toContain('templates/baked-extras/');
    const savedBackground = await first<{ r2_key: string; sha256: string }>(
      env.DB,
      'SELECT r2_key, sha256 FROM template_version_extras WHERE template_id = ? AND version = ? AND name = ?',
      [old.template.id, old.template.version, 'background.png'],
    );
    if (!savedBackground) throw new Error('Second baked preview extra was not persisted');
    expect(savedBackground.sha256).toBe(await sha256Hex(background));
    expect(
      await first(
        env.DB,
        'SELECT extras_hash FROM template_version_extra_sets WHERE template_id = ? AND version = ?',
        [old.template.id, old.template.version],
      ),
    ).not.toBeNull();
    const oldObject = await env.BUCKET.get(savedExtra.r2_key);
    if (!oldObject) throw new Error('Baked preview extra object is missing');
    expect(new Uint8Array(await oldObject.arrayBuffer())).toEqual(oldBytes);
    const releasesOf = () =>
      all<{
        id: string;
        mode: string;
        version: string;
        generation: number;
        content_hash: string;
        candidate_hash: string;
      }>(
        env.DB,
        'SELECT id, mode, version, generation, content_hash, candidate_hash FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
        [old.template.id],
      );
    const initial = await releasesOf();
    expect(initial).toHaveLength(2);
    const forged = {
      ...old,
      template: {
        ...old.template,
        extras: old.template.extras.map((entry) =>
          entry.name === 'strip.png' ? { ...newExtra, path: oldExtra.path } : entry,
        ),
      },
    };
    const forgedCtx = createServiceContext(
      bakedWorker('baked-preview-forged', '9992-01-01T00:00:00Z'),
      { clock },
    );
    assets.files.set(oldExtra.path, newBytes);
    try {
      await expect(
        syncBakedTemplates(forgedCtx, sourceOf([forged], 'release-preview-extra-forged')),
      ).rejects.toMatchObject({ code: 'TEMPLATE_VERSION_CONTENT_CONFLICT' });
    } finally {
      assets.files.set(oldExtra.path, oldBytes);
    }
    expect(await releasesOf()).toEqual(initial);
    const preserved = await env.BUCKET.get(savedExtra.r2_key);
    if (!preserved) throw new Error('Original preview extra disappeared');
    expect(new Uint8Array(await preserved.arrayBuffer())).toEqual(oldBytes);

    const nextCtx = createServiceContext(
      bakedWorker('baked-preview-next', '9993-01-01T00:00:00Z'),
      { clock },
    );
    const nextSource = sourceOf([next], 'release-preview-extra-next');
    await syncBakedTemplates(nextCtx, nextSource);
    const after = await releasesOf();
    expect(after).toHaveLength(4);
    for (const mode of ['live', 'test']) {
      const firstRelease = initial.find((row) => row.mode === mode);
      const nextRelease = after.find((row) => row.mode === mode && row.generation === 2);
      expect(nextRelease).toMatchObject({ version: next.template.version, generation: 2 });
      expect(nextRelease?.content_hash).not.toBe(firstRelease?.content_hash);
      expect(nextRelease?.candidate_hash).not.toBe(firstRelease?.candidate_hash);
    }
    for (const path of old.files.keys()) assets.files.delete(path);
    const registry = createTemplateRegistry(env, { ctx: nextCtx, source: nextSource });
    const oldTemplate = await registry.resolve(old.template.id, old.template.version);
    const oldVersion = await getVersion(env.DB, old.template.id, old.template.version);
    if (!oldVersion) throw new Error('Historical baked version is missing');
    const pinnedExtras = await listVersionExtras(env.DB, old.template.id, old.template.version);
    const oldRelease = initial.find((row) => row.mode === 'live');
    if (!oldRelease) throw new Error('Historical baked release is missing');
    expect(await templateContentHash(nextCtx, oldVersion, pinnedExtras)).toBe(
      oldRelease.content_hash,
    );
    const readExtra = async (name: string) =>
      new Uint8Array(await new Response(await registry.openExtra(oldTemplate, name)).arrayBuffer());
    for (const [name, key, bytes] of [
      ['strip.png', savedExtra.r2_key, oldBytes],
      ['background.png', savedBackground.r2_key, background],
    ] as const) {
      expect(await readExtra(name)).toEqual(bytes);
      await env.BUCKET.put(key, newBytes);
      try {
        await expect(readExtra(name)).rejects.toThrow();
        await expect(templateContentHash(nextCtx, oldVersion, pinnedExtras)).rejects.toThrow();
      } finally {
        await env.BUCKET.put(key, bytes);
      }
      expect(await readExtra(name)).toEqual(bytes);
    }
  }, 30_000);

  it('atomically invalidates org-owned and global baked event caches without changing event revisions', async () => {
    const unrelated = await imported('Unrelated Baked Cache Event');
    const owner = { slug: org.slug, name: org.name };
    const owned = await bakedFrom('release-cache-owned', basicPackage(), {
      name: 'Owned Cache',
      org: owner,
    });
    const global = await bakedFrom('release-cache-global', basicPackage(), {
      name: 'Global Cache',
    });
    const nextOwned = await bakedFrom(
      'release-cache-owned',
      basicPackage({ 'logo.png': makePng(90, 40) }),
      {
        name: 'Owned Cache',
        org: owner,
      },
    );
    const nextGlobal = await bakedFrom(
      'release-cache-global',
      basicPackage({ 'logo.png': makePng(100, 40) }),
      {
        name: 'Global Cache',
      },
    );
    for (const fixture of [owned, global, nextOwned, nextGlobal]) {
      for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    }
    const firstCtx = createServiceContext(
      bakedWorker('baked-cache-first', '9991-01-01T00:00:00Z'),
      { clock },
    );
    await syncBakedTemplates(firstCtx, sourceOf([owned, global], 'release-cache-first'));
    const events = [
      { id: await cachedEvent(org.id, 'live', [owned.template.id]), affected: true },
      { id: await cachedEvent(org.id, 'test', [owned.template.id]), affected: true },
      { id: await cachedEvent(otherOrg.id, 'live', [owned.template.id]), affected: false },
      { id: await cachedEvent(org.id, 'live', [global.template.id]), affected: true },
      { id: await cachedEvent(otherOrg.id, 'live', [global.template.id]), affected: true },
      { id: await cachedEvent(org.id, 'test', [global.template.id]), affected: true },
      { id: await cachedEvent(otherOrg.id, 'test', [global.template.id]), affected: true },
      { id: await cachedEvent(org.id, 'live', [unrelated.id]), affected: false },
    ];
    const cachesBefore = await Promise.all(events.map(({ id }) => expectedCache(id)));
    const releaseRows = () =>
      all(env.DB, 'SELECT * FROM template_releases WHERE template_id IN (?, ?) ORDER BY id', [
        owned.template.id,
        global.template.id,
      ]);
    const rowsBefore = await releaseRows();
    const ownedAudits = await audits(owned.template.id);
    const globalAudits = await audits(global.template.id);
    const nextCtx = createServiceContext(bakedWorker('baked-cache-next', '9992-01-01T00:00:00Z'), {
      clock,
    });
    const nextSource = sourceOf([nextOwned, nextGlobal], 'release-cache-next');
    const blocked = events[0];
    if (!blocked) throw new Error('Missing event fixture');
    await run(
      env.DB,
      `CREATE TRIGGER fail_baked_event_cache BEFORE UPDATE OF expected, expected_at ON scan_events
      WHEN OLD.id = '${blocked.id}' BEGIN SELECT RAISE(ABORT, 'cache down'); END`,
    );
    try {
      await expect(syncBakedTemplates(nextCtx, nextSource)).rejects.toThrow();
    } finally {
      await run(env.DB, 'DROP TRIGGER fail_baked_event_cache');
    }
    expect(await Promise.all(events.map(({ id }) => expectedCache(id)))).toEqual(cachesBefore);
    expect(await releaseRows()).toEqual(rowsBefore);
    expect(await audits(owned.template.id)).toEqual(ownedAudits);
    expect(await audits(global.template.id)).toEqual(globalAudits);
    await syncBakedTemplates(nextCtx, nextSource);
    expect(await releaseRows()).toHaveLength(rowsBefore.length + 4);
    for (const [index, event] of events.entries()) {
      const before = cachesBefore[index];
      expect(await expectedCache(event.id)).toEqual(
        event.affected
          ? { expected: null, expected_at: null, updated_at: before?.updated_at }
          : before,
      );
    }
  }, 30_000);

  it('does not trust missing baked bytes and backfills when the same generated build becomes available', async () => {
    const fixture = await bakedFrom('release-backfill', basicPackage(), {
      name: 'Backfill Baked Release',
      org: { slug: org.slug, name: org.name },
    });
    const missing = fixture.template.assets[0]?.source.path;
    if (!missing) throw new Error('Baked fixture has no asset');
    for (const [path, bytes] of fixture.files) if (path !== missing) assets.files.set(path, bytes);
    const ctx = createServiceContext(bakedWorker('baked-backfill', '9994-01-01T00:00:00Z'), {
      clock,
    });
    const source = sourceOf([fixture], 'release-system-backfill');
    await syncBakedTemplates(ctx, source);
    const findRows = () =>
      all<{ id: string; mode: string; generation: number }>(
        env.DB,
        'SELECT id, mode, generation FROM template_releases WHERE template_id = ? ORDER BY mode',
        [fixture.template.id],
      );
    expect(await findRows()).toEqual([]);
    const bytes = fixture.files.get(missing);
    if (!bytes) throw new Error('Missing fixture source bytes');
    assets.files.set(missing, bytes);
    await syncBakedTemplates(ctx, source);
    const backfilled = await findRows();
    expect(backfilled.map((row) => row.mode)).toEqual(['live', 'test']);
    expect(backfilled.every((row) => row.generation === 1)).toBe(true);
    await syncBakedTemplates(ctx, source);
    expect(await findRows()).toEqual(backfilled);
  });

  it('rolls back a system sync if its release audit cannot be committed', async () => {
    const fixture = await bakedFrom('release-audit-atomic', basicPackage(), {
      name: 'Baked Audit Atomic',
      org: { slug: org.slug, name: org.name },
    });
    for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    const ctx = createServiceContext(bakedWorker('baked-audit', '9995-01-01T00:00:00Z'), { clock });
    const source = sourceOf([fixture], 'release-system-audit-atomic');
    await run(
      env.DB,
      `CREATE TRIGGER fail_baked_release_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'template.release' AND NEW.actor_type = 'system'
       AND NEW.target_id = 'baked:release-audit-atomic'
      BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
    );
    try {
      await expect(syncBakedTemplates(ctx, source)).rejects.toThrow();
    } finally {
      await run(env.DB, 'DROP TRIGGER fail_baked_release_audit');
    }
    expect(
      await first(env.DB, 'SELECT id FROM templates WHERE id = ?', [fixture.template.id]),
    ).toBeNull();
    expect(
      await all(env.DB, 'SELECT id FROM template_releases WHERE template_id = ?', [
        fixture.template.id,
      ]),
    ).toEqual([]);
    expect(
      await all(env.DB, 'SELECT id FROM audit_log WHERE target_id = ?', [fixture.template.id]),
    ).toEqual([]);
    await syncBakedTemplates(ctx, source);
    const releases = await all<{ mode: string; generation: number }>(
      env.DB,
      'SELECT mode, generation FROM template_releases WHERE template_id = ? ORDER BY mode',
      [fixture.template.id],
    );
    expect(releases).toEqual([
      { mode: 'live', generation: 1 },
      { mode: 'test', generation: 1 },
    ]);
  });

  it('fences an old worker both before and immediately at its sync transaction', async () => {
    const initial = await bakedFrom('release-worker-race', basicPackage(), {
      name: 'Baked Worker Race',
      org: { slug: org.slug, name: org.name },
    });
    const older = await bakedFrom(
      'release-worker-race',
      basicPackage({ 'logo.png': makePng(88, 40) }),
      {
        name: 'Baked Worker Race',
        org: { slug: org.slug, name: org.name },
      },
    );
    const newer = await bakedFrom(
      'release-worker-race',
      basicPackage({ 'logo.png': makePng(96, 40) }),
      {
        name: 'Baked Worker Race',
        org: { slug: org.slug, name: org.name },
      },
    );
    for (const fixture of [initial, older, newer]) {
      for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    }
    const initialEnv = bakedWorker('initial-worker', '9996-01-01T00:00:00Z');
    const oldEnv = bakedWorker('old-worker', '9997-01-01T00:00:00Z');
    const newEnv = bakedWorker('new-worker', '9998-01-01T00:00:00Z');
    const initialSource = sourceOf([initial], 'release-worker-initial');
    const oldSource = sourceOf([older], 'release-worker-old');
    const newSource = sourceOf([newer], 'release-worker-new');
    await syncBakedTemplates(createServiceContext(initialEnv, { clock }), initialSource);
    const event = await cachedEvent(org.id, 'live', [initial.template.id]);
    const cacheBefore = await expectedCache(event);
    let intercepted = 0;
    const oldDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            intercepted++;
            await syncBakedTemplates(createServiceContext(newEnv, { clock }), newSource);
            expect(await expectedCache(event)).toEqual({
              expected: null,
              expected_at: null,
              updated_at: cacheBefore?.updated_at,
            });
            await setExpectedCache(event, 91);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const racingEnv: AppEnv = { ...oldEnv, DB: oldDb };
    // The refused write is retried once against the newer build's state, which this older worker serves.
    await expect(
      syncBakedTemplates(createServiceContext(racingEnv, { clock }), oldSource),
    ).resolves.toBeUndefined();
    expect(intercepted).toBe(1);
    expect(await expectedCache(event)).toEqual({
      expected: 91,
      expected_at: clock.now() - 1000,
      updated_at: cacheBefore?.updated_at,
    });
    const rows = () =>
      all<{ mode: string; version: string; generation: number }>(
        env.DB,
        'SELECT mode, version, generation FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
        [initial.template.id],
      );
    const committed = await rows();
    expect(committed).toEqual([
      { mode: 'live', version: initial.template.version, generation: 1 },
      { mode: 'live', version: newer.template.version, generation: 2 },
      { mode: 'test', version: initial.template.version, generation: 1 },
      { mode: 'test', version: newer.template.version, generation: 2 },
    ]);
    expect(
      await first(env.DB, 'SELECT active_version FROM templates WHERE id = ?', [
        initial.template.id,
      ]),
    ).toEqual({
      active_version: newer.template.version,
    });
    const auditBefore = await audits(initial.template.id);
    expect(auditBefore).toHaveLength(4);
    resetBakedSync();
    await expect(
      syncBakedTemplates(createServiceContext(oldEnv, { clock }), oldSource),
    ).resolves.toBeUndefined();
    expect(await rows()).toEqual(committed);
    expect(await audits(initial.template.id)).toEqual(auditBefore);
  });
});
